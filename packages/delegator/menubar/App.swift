import AppKit
import SwiftUI

private let runnerLabel = "com.factory.factory-delegator.runner"
private let menuBarLabel = "com.factory.factory-delegator.menubar"

@MainActor
private final class RunnerModel: ObservableObject {
    @Published var status = RunnerStatus(state: .starting, snapshot: nil)
    @Published var runnerLoaded = false
    @Published var loginEnabled = true
    @Published var actionError: String?

    private var stateDirectory: URL {
        let configured = ProcessInfo.processInfo.environment["XDG_STATE_HOME"] ?? ""
        let base = configured.hasPrefix("/") ? URL(fileURLWithPath: configured) : FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/state")
        return base.appending(path: "factory")
    }
    private let agentsDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/LaunchAgents")

    var runnerInstalled: Bool {
        FileManager.default.fileExists(atPath: agentsDirectory.appending(path: "\(runnerLabel).plist").path)
    }

    var paused: Bool { FileManager.default.fileExists(atPath: stateDirectory.appending(path: "paused").path) }

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
        runnerLoaded = AppCommands.launchctl("print", "gui/\(getuid())/\(runnerLabel)")
        let path = stateDirectory.appending(path: "status.json")
        let data = try? Data(contentsOf: path)
        status = runnerState(json: data, launchAgentLoaded: runnerLoaded, now: .now)
        loginEnabled = AppCommands.loginEnabled(menuBarLabel)
    }

    func run(_ option: String) {
        actionError = AppCommands.installer(option)
        refresh()
    }

    func pause(_ value: Bool) {
        let flag = stateDirectory.appending(path: "paused")
        do {
            try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if value { _ = FileManager.default.createFile(atPath: flag.path, contents: Data(), attributes: [.posixPermissions: 0o600]) }
            else { try FileManager.default.removeItem(at: flag) }
        } catch { actionError = error.localizedDescription }
        refresh()
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
}

private enum AppCommands {
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

    var body: some Scene {
        MenuBarExtra {
            RunnerMenu(runner: runner)
        } label: {
            Label(runner.status.state.line, systemImage: runner.status.state.icon)
        }
        .menuBarExtraStyle(.menu)
    }
}

private struct RunnerMenu: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        Text(runner.status.state.line)
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
                    let watch = item.element
                    HStack {
                        Text(watch.identifier)
                        if let date = isoDate(watch.since) { Text(date, style: .relative) }
                    }
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
                    Text("\(entry.identifier ?? "Unknown") · \(entry.outcome) · \(isoDate(entry.time).map { RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: .now) } ?? entry.time)")
                }
            }
        }
        Divider()
        Toggle("Pause new work", isOn: Binding(
            get: { runner.paused },
            set: { runner.pause($0) }
        )).disabled(!runner.runnerInstalled)
        Button("Open logs") { runner.open(FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/factory-delegator")) }
        Button("Open config") { runner.open(FileManager.default.homeDirectoryForCurrentUser.appending(path: ".config/factory-delegator/config.json")) }
        Divider()
        Toggle("Start at login", isOn: Binding(
            get: { runner.loginEnabled },
            set: { runner.run($0 ? "--enable-app-login" : "--disable-app-login") }
        ))
        if runner.runnerInstalled {
            Button(runner.runnerLoaded ? "Stop Runner" : "Start Runner") {
                runner.run(runner.runnerLoaded ? "--stop-runner" : "--start-runner")
            }
            Button("Remove Runner") { runner.run("--uninstall-runner") }
        } else {
            Button("Install Runner") { runner.run("--install-runner") }
        }
        if let error = runner.actionError, !error.isEmpty { Text(error) }
        Button("Quit menu bar app") { NSApplication.shared.terminate(nil) }
    }
}
