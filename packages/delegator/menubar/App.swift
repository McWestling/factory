import AppKit
import SwiftUI

private let runnerLabel = "com.mcwestling.factory-delegator.runner"
private let menuBarLabel = "com.mcwestling.factory-delegator.menubar"
/// The Keychain item setup stores for a Mac without a Runner: the viewer secret, with the Cloud Inbox URL as its comment.
private let poolService = "com.mcwestling.factory-delegator.pool"
private let configFile = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".config/factory-delegator/config.json")

@MainActor
private final class RunnerModel: ObservableObject {
    @Published var status = RunnerStatus(state: .starting, snapshot: nil)
    @Published var runnerLoaded = false
    @Published var loginEnabled = true
    @Published var actionError: String?
    @Published var routing: ModelRouting?

    private var stateDirectory: URL {
        let configured = ProcessInfo.processInfo.environment["XDG_STATE_HOME"] ?? ""
        let base = configured.hasPrefix("/") ? URL(fileURLWithPath: configured) : FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/state")
        return base.appending(path: "factory")
    }
    private var refreshing = false
    private let agentsDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/LaunchAgents")

    var runnerInstalled: Bool {
        FileManager.default.fileExists(atPath: agentsDirectory.appending(path: "\(runnerLabel).plist").path)
    }

    var configured: Bool { FileManager.default.fileExists(atPath: configFile.path) }

    var paused: Bool { FileManager.default.fileExists(atPath: stateDirectory.appending(path: "paused").path) }

    var state: RunnerState {
        status.snapshot?.state(paused: paused) ?? (paused ? .off : status.state)
    }

    init() {
        refresh()
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                refresh()
            }
        }
    }

    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        let path = stateDirectory.appending(path: "status.json")
        Task.detached(priority: .utility) { [weak self] in
            let loaded = AppCommands.launchctl("print", "gui/\(getuid())/\(runnerLabel)")
            let status = runnerState(json: try? Data(contentsOf: path), launchAgentLoaded: loaded, now: .now)
            let loginEnabled = AppCommands.loginEnabled(menuBarLabel)
            let routing = (try? Data(contentsOf: configFile)).flatMap(modelRouting)
            await self?.finishRefresh(loaded: loaded, status: status, loginEnabled: loginEnabled, routing: routing)
        }
    }

    func run(_ option: String) {
        Task.detached(priority: .utility) { [weak self] in
            let error = AppCommands.installer(option)
            await self?.finishAction(error)
        }
    }

    /// On while the Runner is loaded and takes work.
    var on: Bool { runnerLoaded && !paused }

    /// Off sets the `paused` flag: the current job finishes, nothing new starts, and the flag outlasts a restart.
    /// On clears it and starts the Runner if it isn't loaded.
    func turn(on value: Bool) {
        let flag = stateDirectory.appending(path: "paused")
        do {
            try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if !value { _ = FileManager.default.createFile(atPath: flag.path, contents: Data(), attributes: [.posixPermissions: 0o600]) }
            else if paused { try FileManager.default.removeItem(at: flag) }
        } catch { actionError = error.localizedDescription; return }
        objectWillChange.send()
        if value && !runnerLoaded { run("--start-runner") } else { refresh() }
    }

    /// Rewrites only `levels.<level>`, atomically and still mode 600. The Runner rereads it before its next claim.
    func pick(_ model: String, for level: String) {
        let temporary = configFile.appendingPathExtension("tmp")
        do {
            guard let edited = settingLevel(level, to: model, in: try Data(contentsOf: configFile)) else {
                actionError = "Couldn't change the \(level) model: the config isn't valid or has no such model."
                return
            }
            try? FileManager.default.removeItem(at: temporary)
            let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            try handle.write(contentsOf: edited)
            try handle.close()
            guard Darwin.rename(temporary.path, configFile.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            actionError = nil
            routing = modelRouting(json: edited)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            actionError = "Couldn't change the \(level) model: \(error.localizedDescription)"
        }
    }

    func openOrca() {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.stablyai.orca") else {
            actionError = "Orca isn't installed."
            return
        }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
            if let error { Task { @MainActor in self?.actionError = error.localizedDescription } }
        }
    }

    func open(_ path: URL) {
        NSWorkspace.shared.open(path)
    }

    private func finishRefresh(loaded: Bool, status: RunnerStatus, loginEnabled: Bool, routing: ModelRouting?) {
        refreshing = false
        if self.routing != routing { self.routing = routing }
        if runnerLoaded != loaded { runnerLoaded = loaded }
        if self.status != status { self.status = status }
        if self.loginEnabled != loginEnabled { self.loginEnabled = loginEnabled }
    }

    private func finishAction(_ error: String?) {
        actionError = error
        refresh()
    }
}

/// The Pool section: fetched when the menu opens and once a minute, keeping the last result when a fetch fails.
@MainActor
private final class PoolModel: ObservableObject {
    @Published var lines: [String]?
    @Published var fetchedAt: Date?
    /// Why the last fetch failed; nil after a success.
    @Published var problem: String?
    private var fetching = false

    /// The last result, with its time once a later fetch has failed; otherwise why there's none.
    var display: [String] {
        guard let problem else { return lines ?? [] }
        guard let lines, let fetchedAt else { return [problem] }
        return lines + ["As of \(fetchedAt.formatted(date: .omitted, time: .shortened))"]
    }

    init() {
        refresh()
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                refresh()
            }
        }
        NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        guard !fetching else { return }
        fetching = true
        Task.detached(priority: .utility) { [weak self] in
            let result = await AppCommands.fetchPool()
            await self?.finish(result)
        }
    }

    private func finish(_ result: Result<[String], PoolProblem>) {
        fetching = false
        switch result {
        case .success(let lines):
            if self.lines != lines { self.lines = lines }
            fetchedAt = .now
            if problem != nil { problem = nil }
        case .failure(let failure):
            if problem != failure.message { problem = failure.message }
        }
    }
}

private struct PoolProblem: Error { let message: String }

private enum AppCommands {
    /// Reads `GET /pool` with the viewer secret setup stored in the Keychain, or on a Runner Mac the Runner's own secret.
    static func fetchPool() async -> Result<[String], PoolProblem> {
        guard let (inbox, secret) = poolAccess() else { return .failure(PoolProblem(message: "Not set up. Run npm run setup.")) }
        var request = URLRequest(url: inbox.appending(path: "pool"), timeoutInterval: 15)
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        do {
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else { return .failure(PoolProblem(message: "Cloud Inbox answered \(code).")) }
            return poolLines(json: data).map { .success($0) } ?? .failure(PoolProblem(message: "Cloud Inbox sent no pool."))
        } catch {
            return .failure(PoolProblem(message: "Can't reach Cloud Inbox."))
        }
    }

    /// `security` created the Keychain item, so it reads it without a prompt; the secret stays in memory.
    private static func poolAccess() -> (URL, String)? {
        if let (secret, error) = runWithOutput("/usr/bin/security", ["find-generic-password", "-s", poolService, "-w"]), error.isEmpty,
           let (item, _) = runWithOutput("/usr/bin/security", ["find-generic-password", "-s", poolService]),
           let comment = item.firstMatch(of: #/"icmt"<blob>="([^"]+)"/#)?.1, let url = URL(string: String(comment)) {
            return (url, secret.trimmingCharacters(in: .newlines))
        }
        guard let data = try? Data(contentsOf: configFile),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let inbox = (config["inboxUrl"] as? String).flatMap(URL.init(string:)),
              let secret = config["bearerSecret"] as? String else { return nil }
        return (inbox, secret)
    }

    static func launchctl(_ args: String...) -> Bool {
        runWithOutput("/bin/launchctl", args)?.1.isEmpty ?? false
    }

    static func installer(_ option: String) -> String? {
        guard let script = Bundle.main.resourceURL?.appending(path: "runner/launchd/install.sh") else {
            return "The bundled Runner installer is missing."
        }
        let result = run("/bin/zsh", ["-l", "-c", "exec /bin/sh \"$@\"", "sh", script.path, option])
        return result
    }

    static func loginEnabled(_ label: String) -> Bool {
        guard let (output, _) = runWithOutput("/bin/launchctl", ["print-disabled", "gui/\(getuid())"]) else { return true }
        return !output.contains("\"\(label)\" => disabled")
    }

    private static func run(_ path: String, _ args: [String]) -> String? {
        runWithOutput(path, args)?.1
    }

    private static func runWithOutput(_ path: String, _ args: [String]) -> (String, String)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let stdout = Pipe(), stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do { try process.run() } catch { return ("", error.localizedDescription) }
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let error = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let message = String(decoding: error, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0 else {
            return (String(decoding: output, as: UTF8.self), message.isEmpty ? "Command failed (\(process.terminationStatus))." : message)
        }
        return (String(decoding: output, as: UTF8.self), "")
    }
}

@main
struct FactoryRunnerMenuBarApp: App {
    @StateObject private var runner = RunnerModel()
    @StateObject private var pool = PoolModel()

    var body: some Scene {
        MenuBarExtra {
            RunnerMenu(runner: runner, pool: pool)
        } label: {
            // A Mac without a Runner shows the plain icon.
            let state = !runner.runnerInstalled ? nil : !runner.runnerLoaded && !runner.paused ? RunnerState.starting : runner.state
            Image(nsImage: factoryIcon(state: state))
                .accessibilityLabel(state.map { "Factory: \($0.line)" } ?? "Factory")
        }
        .menuBarExtraStyle(.menu)
    }
}

private let levelMenus: [(level: String, title: String, note: String?)] = [
    ("light", "Light", nil),
    ("standard", "Standard", "Closeouts use this level too"),
    ("deep", "Deep", "Refinement uses this level too"),
]

private struct RunnerMenu: View {
    @ObservedObject var runner: RunnerModel
    @ObservedObject var pool: PoolModel

    var body: some View {
        if runner.runnerInstalled { local }
        if runner.runnerInstalled, let routing = runner.routing {
            Section("Models") {
                ForEach(levelMenus, id: \.level) { item in
                    Menu(item.title) {
                        if let note = item.note { Text(note) }
                        ForEach(routing.models, id: \.self) { model in
                            Toggle(model, isOn: Binding(
                                get: { routing.levels[item.level] == model },
                                set: { if $0 { runner.pick(model, for: item.level) } }
                            ))
                        }
                    }
                }
            }
        }
        let display = pool.display
        if !display.isEmpty {
            Section("Pool") {
                ForEach(Array(display.enumerated()), id: \.offset) { Text($0.element) }
            }
        } else if runner.runnerInstalled {
            Divider()
        }
        if runner.runnerInstalled {
            Toggle("Runner", isOn: Binding(
                get: { runner.on },
                set: { runner.turn(on: $0) }
            ))
        } else if runner.configured {
            Button("Install Runner") { runner.run("--install-runner") }
        }
        if runner.runnerInstalled || runner.configured {
            Button("Open logs") { runner.open(FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/factory-delegator")) }
            Button("Open config") { runner.open(configFile) }
            Divider()
        }
        Toggle("Start at login", isOn: Binding(
            get: { runner.loginEnabled },
            set: { runner.run($0 ? "--enable-app-login" : "--disable-app-login") }
        ))
        if let error = runner.actionError, !error.isEmpty { Text(error) }
        Button("Quit menu bar app") { NSApplication.shared.terminate(nil) }
    }

    /// This Mac's Runner: its state, current job, PR watches, last error and recent jobs.
    @ViewBuilder private var local: some View {
        Text(runner.state.line)
        if let current = runner.status.snapshot?.current {
            Section("Current job") {
                Text(current.identifier)
                Button("Open in Orca") { runner.openOrca() }
                Button("Open issue in Linear") {
                    runner.open(URL(string: "https://linear.app/issue/\(current.identifier)")!)
                }
            }
        }
        if let watches = runner.status.snapshot?.watching, !watches.isEmpty {
            Section("Waiting for a PR") {
                ForEach(Array(watches.enumerated()), id: \.offset) { item in
                    Text("\(item.element.identifier) · \(relativeTime(item.element.since, now: .now))")
                }
            }
        }
        if let error = runner.status.snapshot?.lastError {
            Text("Last error: \(error.outcome)\(error.identifier.map { " (\($0))" } ?? "")")
        }
        if let recent = runner.status.snapshot?.recent, !recent.isEmpty {
            Menu("Recent") {
                ForEach(Array(recent.enumerated()), id: \.offset) { item in
                    let entry = item.element
                    Text("\(entry.identifier ?? "Unknown") · \(entry.outcome) · \(relativeTime(entry.time, now: .now))")
                }
            }
        }
    }
}

// Composite the badge into one template so macOS tints the whole icon for either menu bar style.
private func factoryIcon(state: RunnerState?) -> NSImage {
    let image = NSImage(size: NSSize(width: 22, height: 18), flipped: false) { _ in
        NSImage(systemSymbolName: "building.2", accessibilityDescription: nil)?
            .draw(in: NSRect(x: 0, y: 1, width: 18, height: 16))
        if let state, let badge = state.badge {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.compositingOperation = .copy
            NSColor.clear.setFill()
            NSBezierPath(ovalIn: NSRect(x: 13, y: 0, width: 9, height: 10)).fill()
            NSGraphicsContext.restoreGraphicsState()
            NSImage(systemSymbolName: badge, accessibilityDescription: nil)?
                .draw(in: NSRect(x: 15, y: state.badge == "circle.fill" ? 2 : 1, width: 6, height: state.badge == "circle.fill" ? 6 : 8))
        }
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = state.map { "Factory: \($0.line)" } ?? "Factory"
    return image
}
