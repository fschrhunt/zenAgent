import CoreGraphics
import Foundation

private struct WindowDescription: Encodable {
    let id: UInt32
    let owner: String
    let layer: Int
}

private let options: CGWindowListOption = [
    .optionOnScreenOnly,
    .excludeDesktopElements,
]
private let rawWindows =
    CGWindowListCopyWindowInfo(options, kCGNullWindowID)
    as? [[String: Any]] ?? []
private let windows = rawWindows.compactMap { window -> WindowDescription? in
    guard
        let id = window[kCGWindowNumber as String] as? UInt32,
        let owner = window[kCGWindowOwnerName as String] as? String,
        let layer = window[kCGWindowLayer as String] as? Int
    else {
        return nil
    }

    return WindowDescription(
        id: id,
        owner: owner,
        layer: layer
    )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(windows))
FileHandle.standardOutput.write(Data([0x0A]))
