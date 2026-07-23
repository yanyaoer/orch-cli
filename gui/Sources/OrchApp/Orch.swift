import Foundation

struct Workspace: Decodable {
    let id: String
    let path: String
}

struct RunInfo: Decodable {
    let run_id: String
    let mr: String
    let role: String
    let agent: String
    let state: String
    let updated_at: String?
    let exit_code: Int?
}

struct MRStatus: Decodable {
    let mr: String
    let runs: [RunInfo]
}

struct RepoStatus: Decodable {
    let repo_key: String?
    let mrs: [MRStatus]
}

enum Orch {
    static let binary: String = {
        let local = ("~/.local/bin/orch" as NSString).expandingTildeInPath
        return FileManager.default.isExecutableFile(atPath: local) ? local : ""
    }()

    static func process(_ args: [String], cwd: String? = nil) -> Process {
        let p = Process()
        if binary.isEmpty {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["orch"] + args
        } else {
            p.executableURL = URL(fileURLWithPath: binary)
            p.arguments = args
        }
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:"
            + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.standardInput = FileHandle.nullDevice
        return p
    }

    /// Run to completion off-main; callback on main with (stdout, errorMessage).
    static func capture(_ args: [String], cwd: String? = nil,
                        completion: @escaping (Data?, String?) -> Void) {
        DispatchQueue.global().async {
            let p = process(args, cwd: cwd)
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            do { try p.run() } catch {
                DispatchQueue.main.async { completion(nil, "无法启动 orch: \(error.localizedDescription)") }
                return
            }
            // read both pipes concurrently so a full stderr buffer can't deadlock the child
            let group = DispatchGroup()
            var outData = Data(), errData = Data()
            group.enter()
            DispatchQueue.global().async {
                outData = out.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.enter()
            DispatchQueue.global().async {
                errData = err.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.wait()
            p.waitUntilExit()
            DispatchQueue.main.async {
                if p.terminationStatus == 0 {
                    completion(outData, nil)
                } else {
                    let msg = String(data: errData, encoding: .utf8) ?? ""
                    completion(nil, "orch \(args.joined(separator: " ")) 退出码 \(p.terminationStatus)\n\(msg)")
                }
            }
        }
    }
}

/// Forwards a pipe's bytes as UTF-8 text, holding back incomplete trailing sequences.
final class PipeReader {
    private var carry = Data()

    init(_ pipe: Pipe, onText: @escaping (String) -> Void) {
        pipe.fileHandleForReading.readabilityHandler = { [self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            carry.append(data)
            if let s = String(data: carry, encoding: .utf8) {
                carry.removeAll()
                DispatchQueue.main.async { onText(s) }
            } else {
                for cut in 1...3 where carry.count > cut {
                    if let s = String(data: carry.prefix(carry.count - cut), encoding: .utf8) {
                        carry.removeFirst(carry.count - cut)
                        DispatchQueue.main.async { onText(s) }
                        break
                    }
                }
            }
        }
    }
}

/// One long-running orch child process with stdout+stderr streamed as text.
final class StreamTask {
    let process: Process
    private var readers: [PipeReader] = []

    var isRunning: Bool { process.isRunning }

    init?(_ args: [String], cwd: String? = nil,
          onText: @escaping (String) -> Void,
          onExit: ((Int32) -> Void)? = nil) {
        process = Orch.process(args, cwd: cwd)
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        readers = [PipeReader(out, onText: onText), PipeReader(err, onText: onText)]
        process.terminationHandler = { p in
            DispatchQueue.main.async { onExit?(p.terminationStatus) }
        }
        do { try process.run() } catch {
            DispatchQueue.main.async { onText("⚠️ 无法启动 orch: \(error.localizedDescription)\n") }
            return nil
        }
    }

    func interrupt() { if process.isRunning { process.interrupt() } }
    func terminate() { if process.isRunning { process.terminate() } }
}
