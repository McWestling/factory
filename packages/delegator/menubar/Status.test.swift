import Foundation

@main
enum StatusCheck {
    static func main() {
        let now = ISO8601DateFormatter().date(from: "2026-01-15T08:00:00Z")!
        func line(_ json: String?, loaded: Bool = true) -> String {
            runnerState(json: json.map { Data($0.utf8) }, launchAgentLoaded: loaded, now: now).state.line
        }
        let idle = #"{"version":1,"updatedAt":"2026-01-15T08:00:00Z","inbox":{"status":"ok","lastOkAt":"2026-01-15T08:00:00Z"},"paused":false,"current":null,"watching":[],"lastError":null,"recent":[]}"#
        assert(line(idle) == "Runner ready")
        assert(line(idle.replacingOccurrences(of: "\"current\":null", with: "\"current\":{\"identifier\":\"DO-1535\",\"sessionId\":\"s1\"}")) == "Working on DO-1535")
        assert(line(idle.replacingOccurrences(of: "\"watching\":[]", with: "\"watching\":[{\"identifier\":\"DO-1535\",\"since\":\"2026-01-15T07:00:00Z\"}]")) == "Waiting for a PR")
        let off = idle.replacingOccurrences(of: "\"paused\":false", with: "\"paused\":true")
        assert(line(off) == "Off")
        assert(line(off.replacingOccurrences(of: "\"current\":null", with: "\"current\":{\"identifier\":\"DO-1535\",\"sessionId\":\"s1\"}")) == "Turning off after the current job")
        assert(line(idle.replacingOccurrences(of: "\"status\":\"ok\"", with: "\"status\":\"unreachable\"")) == "Can't reach Cloud Inbox")
        assert(line(idle.replacingOccurrences(of: "\"lastError\":null", with: "\"lastError\":{\"identifier\":\"DO-1535\",\"outcome\":\"failed\",\"time\":\"2026-01-15T08:00:00Z\"}")) == "Last job failed")
        assert(line(nil, loaded: false) == "Off")
        assert(line(nil) == "Starting Runner…")
        assert(line(idle.replacingOccurrences(of: "2026-01-15T08:00:00Z", with: "2026-01-15T07:59:00Z")) == "Starting Runner…")
        let initial = runnerState(json: Data(idle.utf8), launchAgentLoaded: true, now: now)
        let refreshed = idle.replacingOccurrences(of: "2026-01-15T08:00:00Z", with: "2026-01-15T08:00:05Z")
        assert(initial == runnerState(json: Data(refreshed.utf8), launchAgentLoaded: true, now: now.addingTimeInterval(5)))
        assert(initial != runnerState(json: Data(idle.replacingOccurrences(of: "\"paused\":false", with: "\"paused\":true").utf8), launchAgentLoaded: true, now: now))
    }
}
