import AVFoundation
import Foundation
import Speech

private let currentContractVersion = 1
private let maximumAudioBytes: UInt64 = 1_073_741_824

private struct Success<Result: Encodable>: Encodable {
    let ok = true
    let contractVersion = currentContractVersion
    let result: Result
}

private struct FailureBody: Encodable {
    let code: String
    let message: String
}

private struct Failure: Encodable {
    let ok = false
    let contractVersion = currentContractVersion
    let error: FailureBody
}

private struct ContractResult: Encodable {
    let platform = "macOS"
    let minimumVersion = "26.0"
    let engine = "SpeechAnalyzer/SpeechTranscriber"
    let prerecordedAudioOnly = true
    let onDeviceOnly = true
    let runtimeDownloads = false
}

private struct LocaleResult: Encodable {
    let supportedLocales: [String]
    let installedLocales: [String]
}

private struct InstallResult: Encodable {
    let locale: String
    let installed: Bool
}

private struct TranscriptResult: Encodable {
    let locale: String
    let text: String
}

private enum HelperError: Error {
    case invalidArguments(String)
    case unavailable
    case unsupportedLocale
    case modelNotInstalled
    case invalidInput
    case inputTooLarge
    case operationFailed

    var body: FailureBody {
        switch self {
        case .invalidArguments(let usage):
            return FailureBody(code: "invalid-arguments", message: usage)
        case .unavailable:
            return FailureBody(
                code: "unsupported-platform",
                message: "On-device transcription requires macOS 26 or newer."
            )
        case .unsupportedLocale:
            return FailureBody(
                code: "unsupported-locale",
                message: "SpeechTranscriber does not support the requested locale."
            )
        case .modelNotInstalled:
            return FailureBody(
                code: "model-not-installed",
                message:
                    "The requested on-device speech model is not installed. Run the explicit setup install command first."
            )
        case .invalidInput:
            return FailureBody(
                code: "invalid-input",
                message: "Input must be an absolute path to a readable prerecorded audio file."
            )
        case .inputTooLarge:
            return FailureBody(
                code: "input-too-large",
                message: "The prerecorded audio file exceeds the 1 GiB helper limit."
            )
        case .operationFailed:
            return FailureBody(
                code: "speech-failed",
                message: "The on-device speech operation could not be completed."
            )
        }
    }
}

private func emit<T: Encodable>(_ value: T, to handle: FileHandle = .standardOutput) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(value)
    handle.write(data)
    handle.write(Data([0x0A]))
}

private func canonicalLocale(_ identifier: String) throws -> Locale {
    let canonical = Locale(identifier: identifier).identifier(.bcp47)
    guard canonical == identifier else {
        throw HelperError.invalidArguments(
            "Locale must be a canonical BCP-47 identifier such as en-US."
        )
    }
    return Locale(identifier: identifier)
}

private func localeIdentifiers(_ locales: [Locale]) -> [String] {
    locales.map { $0.identifier(.bcp47) }.sorted()
}

private func requireOption(_ arguments: [String], _ name: String) throws -> String {
    guard
        let index = arguments.firstIndex(of: name),
        index + 1 < arguments.count
    else {
        throw HelperError.invalidArguments("Missing required option \(name).")
    }
    return arguments[index + 1]
}

@available(macOS 26.0, *)
private func locales() async -> LocaleResult {
    async let supported = SpeechTranscriber.supportedLocales
    async let installed = SpeechTranscriber.installedLocales
    return await LocaleResult(
        supportedLocales: localeIdentifiers(supported),
        installedLocales: localeIdentifiers(installed)
    )
}

@available(macOS 26.0, *)
private func isSupported(_ locale: Locale) async -> Bool {
    let identifier = locale.identifier(.bcp47)
    return await SpeechTranscriber.supportedLocales.contains {
        $0.identifier(.bcp47) == identifier
    }
}

@available(macOS 26.0, *)
private func isInstalled(_ locale: Locale) async -> Bool {
    let identifier = locale.identifier(.bcp47)
    return await SpeechTranscriber.installedLocales.contains {
        $0.identifier(.bcp47) == identifier
    }
}

@available(macOS 26.0, *)
private func install(locale: Locale) async throws -> InstallResult {
    guard await isSupported(locale) else {
        throw HelperError.unsupportedLocale
    }
    if await isInstalled(locale) {
        return InstallResult(locale: locale.identifier(.bcp47), installed: true)
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    if let request = try await AssetInventory.assetInstallationRequest(
        supporting: [transcriber]
    ) {
        try await request.downloadAndInstall()
    }
    guard await isInstalled(locale) else {
        throw HelperError.operationFailed
    }
    return InstallResult(locale: locale.identifier(.bcp47), installed: true)
}

@available(macOS 26.0, *)
private func transcribe(locale: Locale, inputPath: String) async throws -> TranscriptResult {
    guard await isSupported(locale) else {
        throw HelperError.unsupportedLocale
    }
    guard await isInstalled(locale) else {
        // Deliberately no AssetInventory installation request here. Runtime
        // transcription must remain local and non-interactive.
        throw HelperError.modelNotInstalled
    }

    let inputURL = URL(fileURLWithPath: inputPath)
    guard inputURL.path == inputPath else {
        throw HelperError.invalidInput
    }
    let values = try inputURL.resourceValues(forKeys: [
        .isRegularFileKey,
        .isReadableKey,
        .fileSizeKey,
    ])
    guard values.isRegularFile == true, values.isReadable == true else {
        throw HelperError.invalidInput
    }
    if UInt64(values.fileSize ?? 0) > maximumAudioBytes {
        throw HelperError.inputTooLarge
    }

    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: inputURL)
    } catch {
        throw HelperError.invalidInput
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    async let transcript = transcriber.results.reduce(into: "") {
        $0 += String($1.text.characters)
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    if let lastSample = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    return try await TranscriptResult(
        locale: locale.identifier(.bcp47),
        text: transcript
    )
}

@main
private struct ZenAgentSpeechHelper {
    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first else {
                throw HelperError.invalidArguments(
                    "Usage: zen-agent-speech <contract|locales|install|transcribe>."
                )
            }

            if command == "contract" {
                try emit(Success(result: ContractResult()))
                return
            }
            guard #available(macOS 26.0, *) else {
                throw HelperError.unavailable
            }

            switch command {
            case "locales":
                guard arguments.count == 1 else {
                    throw HelperError.invalidArguments(
                        "Usage: zen-agent-speech locales."
                    )
                }
                try await emit(Success(result: locales()))
            case "install":
                guard arguments.count == 3 else {
                    throw HelperError.invalidArguments(
                        "Usage: zen-agent-speech install --locale <bcp47>."
                    )
                }
                let locale = try canonicalLocale(
                    requireOption(arguments, "--locale")
                )
                try await emit(Success(result: install(locale: locale)))
            case "transcribe":
                guard arguments.count == 5 else {
                    throw HelperError.invalidArguments(
                        "Usage: zen-agent-speech transcribe --locale <bcp47> --input <absolute-audio-path>."
                    )
                }
                let locale = try canonicalLocale(
                    requireOption(arguments, "--locale")
                )
                let input = try requireOption(arguments, "--input")
                guard input.hasPrefix("/") else {
                    throw HelperError.invalidInput
                }
                try await emit(
                    Success(result: transcribe(locale: locale, inputPath: input))
                )
            default:
                throw HelperError.invalidArguments(
                    "Usage: zen-agent-speech <contract|locales|install|transcribe>."
                )
            }
        } catch let error as HelperError {
            try? emit(Failure(error: error.body))
            Foundation.exit(EXIT_FAILURE)
        } catch {
            try? emit(Failure(error: HelperError.operationFailed.body))
            Foundation.exit(EXIT_FAILURE)
        }
    }
}
