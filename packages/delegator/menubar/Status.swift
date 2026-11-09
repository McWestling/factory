import Foundation

struct RunnerSnapshot: Decodable {
    struct Inbox: Decodable { let status: String; let lastOkAt: String? }
    struct Current: Decodable { let identifier: String; let sessionId: String }
    struct Watch: Decodable { let identifier: String; let since: String }
    struct Outcome: Decodable { let identifier: String?; let outcome: String; let time: String }

    let version: Int
    let updatedAt: String
    let inbox: Inbox
    let paused: Bool
    let current: Current?
    let watching: [Watch]
    let lastError: Outcome?
    let recent: [Outcome]
}

enum RunnerState {
    case ready, working(String), waiting, paused, cloudInboxUnreachable
    case failed, stopped, starting

    var line: String {
        switch self {
        case .ready: "Runner ready"
        case .working(let id): "Working on \(id)"
        case .waiting: "Waiting for a PR"
        case .paused: "Paused"
        case .cloudInboxUnreachable: "Can't reach Cloud Inbox"
        case .failed: "Last job failed"
        case .stopped: "Runner stopped"
        case .starting: "Starting Runner…"
        }
    }

    var icon: String {
        switch self {
        case .ready: "checkmark.circle.fill"
        case .working: "gearshape.2.fill"
        case .waiting: "clock.fill"
        case .paused: "pause.circle.fill"
        case .cloudInboxUnreachable: "wifi.exclamationmark"
        case .failed: "exclamationmark.triangle.fill"
        case .stopped: "stop.circle.fill"
        case .starting: "hourglass"
        }
    }
}

struct RunnerStatus {
    let state: RunnerState
    let snapshot: RunnerSnapshot?

    var paused: Bool { snapshot?.paused ?? false }
}

func runnerState(json: Data?, launchAgentLoaded: Bool, now: Date) -> RunnerStatus {
    let snapshot = json.flatMap { try? JSONDecoder().decode(RunnerSnapshot.self, from: $0) }
    guard let snapshot, snapshot.version == 1,
          let updatedAt = isoDate(snapshot.updatedAt), now.timeIntervalSince(updatedAt) <= 30 else {
        return RunnerStatus(state: launchAgentLoaded ? .starting : .stopped, snapshot: nil)
    }
    let state: RunnerState
    if snapshot.paused { state = .paused }
    else if let current = snapshot.current { state = .working(current.identifier) }
    else if snapshot.inbox.status != "ok" { state = .cloudInboxUnreachable }
    else if !snapshot.watching.isEmpty { state = .waiting }
    else if snapshot.lastError != nil { state = .failed }
    else { state = .ready }
    return RunnerStatus(state: state, snapshot: snapshot)
}

func isoDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}
