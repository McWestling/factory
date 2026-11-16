import Foundation

struct RunnerSnapshot: Decodable {
    struct Inbox: Decodable, Equatable { let status: String; let lastOkAt: String? }
    struct Current: Decodable, Equatable { let identifier: String; let sessionId: String }
    struct Watch: Decodable, Equatable { let identifier: String; let since: String }
    struct Outcome: Decodable, Equatable { let identifier: String?; let outcome: String; let time: String }

    let version: Int
    let updatedAt: String
    let inbox: Inbox
    let paused: Bool
    let current: Current?
    let watching: [Watch]
    let lastError: Outcome?
    let recent: [Outcome]
}

enum RunnerState: Equatable {
    case ready, working(String), waiting, turningOff, off, cloudInboxUnreachable
    case failed, starting

    var line: String {
        switch self {
        case .ready: "Runner ready"
        case .working(let id): "Working on \(id)"
        case .waiting: "Waiting for a PR"
        case .turningOff: "Turning off after the current job"
        case .off: "Off"
        case .cloudInboxUnreachable: "Can't reach Cloud Inbox"
        case .failed: "Last job failed"
        case .starting: "Starting Runner…"
        }
    }

    var badge: String? {
        switch self {
        case .ready, .waiting: nil
        case .working, .turningOff: "circle.fill"
        case .off: "pause.fill"
        case .cloudInboxUnreachable, .failed, .starting: "exclamationmark"
        }
    }
}

struct RunnerStatus: Equatable {
    let state: RunnerState
    let snapshot: RunnerSnapshot?

    var paused: Bool { snapshot?.paused ?? false }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.state == rhs.state &&
            lhs.snapshot?.current?.identifier == rhs.snapshot?.current?.identifier &&
            lhs.snapshot?.watching == rhs.snapshot?.watching &&
            lhs.snapshot?.lastError == rhs.snapshot?.lastError &&
            lhs.snapshot?.recent == rhs.snapshot?.recent
    }
}

func runnerState(json: Data?, launchAgentLoaded: Bool, now: Date) -> RunnerStatus {
    let snapshot = json.flatMap { try? JSONDecoder().decode(RunnerSnapshot.self, from: $0) }
    guard let snapshot, snapshot.version == 1,
          let updatedAt = isoDate(snapshot.updatedAt), now.timeIntervalSince(updatedAt) <= 30 else {
        return RunnerStatus(state: launchAgentLoaded ? .starting : .off, snapshot: nil)
    }
    return RunnerStatus(state: snapshot.state(paused: snapshot.paused), snapshot: snapshot)
}

extension RunnerSnapshot {
    func state(paused: Bool) -> RunnerState {
        if paused { return current == nil ? .off : .turningOff }
        if let current { return .working(current.identifier) }
        if inbox.status != "ok" { return .cloudInboxUnreachable }
        if !watching.isEmpty { return .waiting }
        if lastError != nil { return .failed }
        return .ready
    }
}

/// A fixed string, worked out once per render. `Text(date, style: .relative)` must not be used in the menu:
/// its self-scheduled updates re-render the `.menu` MenuBarExtra in a loop and crash the app.
func relativeTime(_ iso: String, now: Date) -> String {
    isoDate(iso).map { RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: now) } ?? iso
}

func isoDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}

/// `GET /pool`: each machine's latest `status.json`, as its Runner last sent it, plus the jobs waiting for a claim.
struct Pool: Decodable {
    struct Machine: Decodable {
        struct Snapshot: Decodable { let paused: Bool?; let current: Current? }
        struct Current: Decodable { let identifier: String }
        let name: String
        let online: Bool
        let snapshot: Snapshot?
    }
    let queueDepth: Int
    let machines: [Machine]
}

/// The Pool section's lines: one per machine (working, idle, off or offline), then the jobs waiting.
/// Nil when the response isn't a pool.
func poolLines(json: Data) -> [String]? {
    guard let pool = try? JSONDecoder().decode(Pool.self, from: json) else { return nil }
    let machines = pool.machines.map { machine in
        guard machine.online, let snapshot = machine.snapshot else { return "\(machine.name) · offline" }
        if let current = snapshot.current { return "\(machine.name) · working · \(current.identifier)" }
        return "\(machine.name) · \(snapshot.paused == true ? "off" : "idle")"
    }
    let waiting = pool.queueDepth == 0 ? "No jobs waiting" : "\(pool.queueDepth) job\(pool.queueDepth == 1 ? "" : "s") waiting"
    return machines + [waiting]
}
