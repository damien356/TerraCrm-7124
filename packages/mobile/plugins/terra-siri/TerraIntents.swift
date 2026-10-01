// Terra crew Siri commands (App Shortcuts). Copied into the iOS app target by
// plugins/terra-siri/app.plugin.js at prebuild. Edit it there, not in ios/.
//
// Every phrase has "Terra" in it (\(.applicationName)), so no setup is needed:
// once the app is installed and opened once, "Hey Siri, what's my next job in
// Terra" works, on the lock screen and on CarPlay.
//
// The server does all the thinking. These intents only:
//   1. read this phone's crew key from the keychain (written by lib/crew-key.ts),
//   2. call /api/rpc/voice/* with header x-terra-voice-key,
//   3. say the `speech` the server sends back.
// Anything that acts (a text, a call, a note) is two steps: voice.prepare gives
// a read-back and a one-use code, Siri reads it back and asks, and only a yes
// sends voice.confirm. A no or silence sends voice.cancel.

import AppIntents
import CoreLocation
import Foundation
import MapKit
import Security
import UIKit

// MARK: - Keychain (must match lib/crew-key.ts and expo-secure-store)

/// expo-secure-store appends ":no-auth" to the service when no Face ID is
/// required, and stores the item name as Data in both account and generic.
private let terraKeychainService = "terra.voice:no-auth"

private func terraKeychainRead(_ name: String) -> String? {
  let tag = Data(name.utf8)
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: terraKeychainService,
    kSecAttrGeneric as String: tag,
    kSecAttrAccount as String: tag,
    kSecMatchLimit as String: kSecMatchLimitOne,
    kSecReturnData as String: true,
  ]
  var out: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else {
    return nil
  }
  return String(data: data, encoding: .utf8)
}

// MARK: - Talking to Terra

/// Said out loud by Siri when thrown from perform().
struct TerraSays: Error, CustomLocalizedStringResourceConvertible {
  let speech: String
  var localizedStringResource: LocalizedStringResource { LocalizedStringResource(stringLiteral: speech) }
}

private let notSwitchedOn = TerraSays(
  speech: "Siri isn't switched on for Terra on this phone. Open Terra, go to the Me tab, and switch on Siri and CarPlay."
)

/// Everything any voice.* call can send. Nil fields are left out of the JSON.
struct VoiceInput: Encodable, Sendable {
  var kind: String? = nil
  var taskId: Int? = nil
  var minutesLate: Int? = nil
  var note: String? = nil
  var token: String? = nil
  var answer: String? = nil
}

/// Everything any voice.* call can answer with. Only `speech` is always there.
struct VoiceReply: Decodable, Sendable {
  var speech: String?
  var readBack: String?
  var token: String?
  var ok: Bool?
  var found: Bool?
  var needsMinutes: Bool?
  var needsNote: Bool?
  var taskId: Int?
  var destination: String?
  var bookedStart: String?
  var navUrl: String?
  var dial: String?
}

private struct RpcBody: Encodable { let json: VoiceInput }
private struct RpcReply: Decodable { let json: VoiceReply }
private struct RpcErrorBody: Decodable { let message: String? }
private struct RpcError: Decodable { let json: RpcErrorBody? }

enum TerraVoice {
  /// POST /api/rpc/voice/<name> in oRPC's wire format: {"json": input} in, {"json": output} back.
  static func call(_ name: String, _ input: VoiceInput = VoiceInput()) async throws -> VoiceReply {
    guard terraKeychainRead("siriOn") == "1",
          let key = terraKeychainRead("voiceKey"), !key.isEmpty,
          let base = terraKeychainRead("apiUrl"), !base.isEmpty
    else { throw notSwitchedOn }

    let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
    guard let url = URL(string: "\(trimmed)/api/rpc/voice/\(name)") else { throw notSwitchedOn }

    var req = URLRequest(url: url, timeoutInterval: 12)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(key, forHTTPHeaderField: "x-terra-voice-key")
    req.httpBody = try JSONEncoder().encode(RpcBody(json: input))

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: req)
    } catch {
      throw TerraSays(speech: "I can't reach Terra right now. Check you've got signal and try again.")
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { throw notSwitchedOn }
    guard (200..<300).contains(status) else {
      let message = (try? JSONDecoder().decode(RpcError.self, from: data))?.json?.message
      throw TerraSays(speech: message ?? "Terra couldn't do that just now. Try again, or call the office.")
    }
    guard let reply = try? JSONDecoder().decode(RpcReply.self, from: data) else {
      throw TerraSays(speech: "Terra sent something I didn't understand. Try again, or call the office.")
    }
    return reply.json
  }

  /// The "no". Runs detached so it still goes out when Siri has cancelled us.
  static func cancel(_ token: String, silence: Bool) async {
    let answer = silence ? "silence" : "no"
    _ = await Task.detached {
      try? await TerraVoice.call("cancel", VoiceInput(token: token, answer: answer))
    }.value
  }

  /// Ask the yes or no for a prepared action. True means go ahead.
  static func askYes<I: AppIntent>(_ intent: I, readBack: String, action: ConfirmationActionName) async -> (Bool, Bool) {
    do {
      try await intent.requestConfirmation(result: .result(dialog: "\(readBack)"), confirmationActionName: action)
      return (true, false)
    } catch {
      return (false, Task.isCancelled || error is CancellationError)
    }
  }
}

// MARK: - How late, from the Maps ETA

/// Drive time from where the phone is now, from Apple Maps. MapKit lives on
/// the main thread. Needs location, so it fails quietly without it.
@MainActor
private func driveSeconds(to destination: String) async throws -> TimeInterval {
  let places = try await CLGeocoder().geocodeAddressString(destination)
  guard let place = places.first else { throw TerraSays(speech: "No such place.") }
  let request = MKDirections.Request()
  request.source = MKMapItem.forCurrentLocation()
  request.destination = MKMapItem(placemark: MKPlacemark(placemark: place))
  request.transportType = .automobile
  let eta = try await MKDirections(request: request).calculateETA()
  return eta.expectedTravelTime
}

/// Minutes late if the drive from here gets in after the booked start, rounded
/// up to the next 5. Nil when it can't tell (no start time, no location, no
/// signal) or they'll make it, and then Siri asks instead.
private func minutesLateFromETA(destination: String?, bookedStart: String?) async -> Int? {
  guard let destination, let bookedStart else { return nil }
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let start = iso.date(from: bookedStart) ?? ISO8601DateFormatter().date(from: bookedStart) else { return nil }

  return await withTaskGroup(of: Int?.self) { group in
    group.addTask {
      guard let seconds = try? await driveSeconds(to: destination) else { return nil }
      let late = Date().addingTimeInterval(seconds).timeIntervalSince(start) / 60
      if late < 3 { return nil }
      return Int((late / 5).rounded(.up)) * 5
    }
    group.addTask {
      try? await Task.sleep(nanoseconds: 6_000_000_000)
      return nil
    }
    let first = await group.next() ?? nil
    group.cancelAll()
    return first
  }
}

// MARK: - Opening things (maps, the phone dialer)

/// Opens a URL from the app. Used for directions and for dialling, which iOS
/// only lets an app do from the front, so the phone has to be unlocked.
struct TerraOpenLink: AppIntent {
  static let title: LocalizedStringResource = "Open in Terra"
  static let openAppWhenRun = true
  static let isDiscoverable = false

  @Parameter(title: "Link") var link: String

  init() {}
  init(_ link: String) { self.link = link }

  @MainActor
  func perform() async throws -> some IntentResult {
    if let url = URL(string: link) { _ = await UIApplication.shared.open(url) }
    return .result()
  }
}

// MARK: - 1. What's my next job

struct TerraNextJob: AppIntent {
  static let title: LocalizedStringResource = "What's my next job"
  static let description = IntentDescription("Says when and where your next Terra job is.")

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let r = try await TerraVoice.call("nextJob")
    return .result(dialog: "\(r.speech ?? "I couldn't find your next job.")")
  }
}

// MARK: - 2. Direct me to my next job

struct TerraDirections: AppIntent {
  static let title: LocalizedStringResource = "Direct me to my next job"
  static let description = IntentDescription("Opens Apple Maps, Google Maps or Waze to your next job, whichever you picked on the Me tab.")

  func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
    let r = try await TerraVoice.call("directions")
    guard let link = r.navUrl else { throw TerraSays(speech: r.speech ?? "There's no address on your next job.") }
    return .result(opensIntent: TerraOpenLink(link), dialog: "\(r.speech ?? "Opening directions.")")
  }
}

// MARK: - 3. What's on the job sheet

struct TerraJobSheet: AppIntent {
  static let title: LocalizedStringResource = "What's on the job sheet"
  static let description = IntentDescription("Reads the job sheet for the job you're at, or your next one.")

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let r = try await TerraVoice.call("jobSheet")
    return .result(dialog: "\(r.speech ?? "There's nothing on the job sheet.")")
  }
}

// MARK: - 4 and 5. Running late (to the client, to the office)

/// Shared by both late commands. Minutes come from Siri asking, else the
/// Maps ETA, else Siri asks "How late, roughly?".
private func runLate<I: AppIntent>(
  _ intent: I,
  kind: String,
  minutes: Int?,
  needMinutes: () -> Error
) async throws -> String {
  let next = try await TerraVoice.call("nextJob")
  guard next.found == true else { return next.speech ?? "You've got nothing booked in the next two weeks." }

  var mins = minutes
  if mins == nil { mins = await minutesLateFromETA(destination: next.destination, bookedStart: next.bookedStart) }
  guard let mins else { throw needMinutes() }

  let prep = try await TerraVoice.call("prepare", VoiceInput(kind: kind, taskId: next.taskId, minutesLate: mins))
  if prep.needsMinutes == true { throw needMinutes() }
  guard prep.ok == true, let token = prep.token else { return prep.speech ?? "I can't send that one." }

  let (yes, silent) = await TerraVoice.askYes(intent, readBack: prep.readBack ?? prep.speech ?? "Send it?", action: .send)
  guard yes else {
    await TerraVoice.cancel(token, silence: silent)
    return "OK, nothing sent."
  }
  let done = try await TerraVoice.call("confirm", VoiceInput(token: token))
  return done.speech ?? "Sent."
}

struct TerraLateClient: AppIntent {
  static let title: LocalizedStringResource = "Tell my next job I'm running late"
  static let description = IntentDescription("Texts the site contact on your next job that you're running late. Reads it back first.")

  @Parameter(title: "Minutes late") var minutes: Int?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let said = try await runLate(self, kind: "late_client", minutes: minutes) {
      $minutes.needsValueError("How late, roughly?")
    }
    return .result(dialog: "\(said)")
  }
}

struct TerraLateOffice: AppIntent {
  static let title: LocalizedStringResource = "Tell the office I'm running late"
  static let description = IntentDescription("Lets the Terra office know you're running late to your next job. Reads it back first.")

  @Parameter(title: "Minutes late") var minutes: Int?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let said = try await runLate(self, kind: "late_office", minutes: minutes) {
      $minutes.needsValueError("How late, roughly?")
    }
    return .result(dialog: "\(said)")
  }
}

// MARK: - 6 and 7. Calls (site contact, office)

private func runCall<I: AppIntent>(_ intent: I, kind: String) async throws -> String {
  let prep = try await TerraVoice.call("prepare", VoiceInput(kind: kind))
  guard prep.ok == true, let token = prep.token else {
    throw TerraSays(speech: prep.speech ?? "I can't make that call.")
  }
  let (yes, silent) = await TerraVoice.askYes(intent, readBack: prep.readBack ?? "Make the call?", action: .call)
  guard yes else {
    await TerraVoice.cancel(token, silence: silent)
    throw TerraSays(speech: "OK, not calling.")
  }
  let done = try await TerraVoice.call("confirm", VoiceInput(token: token))
  guard let digits = done.dial, !digits.isEmpty else {
    throw TerraSays(speech: done.speech ?? "I couldn't get that number.")
  }
  return digits
}

struct TerraCallContact: AppIntent {
  static let title: LocalizedStringResource = "Call the site contact"
  static let description = IntentDescription("Calls the site contact on the job you're at, or your next one. Asks first.")

  func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
    let digits = try await runCall(self, kind: "call_contact")
    return .result(opensIntent: TerraOpenLink("tel://\(digits)"), dialog: "Calling.")
  }
}

struct TerraCallOffice: AppIntent {
  static let title: LocalizedStringResource = "Call the office"
  static let description = IntentDescription("Calls the Terra office. Asks first.")

  func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
    let digits = try await runCall(self, kind: "call_office")
    return .result(opensIntent: TerraOpenLink("tel://\(digits)"), dialog: "Calling.")
  }
}

// MARK: - 8. Add a note to this job

struct TerraAddNote: AppIntent {
  static let title: LocalizedStringResource = "Add a note to this job"
  static let description = IntentDescription("Adds a note for the office to the job you're at. Reads it back first.")

  @Parameter(title: "Note") var note: String?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let text = note?.trimmingCharacters(in: .whitespacesAndNewlines), text.count >= 2 else {
      throw $note.needsValueError("What's the note?")
    }
    let prep = try await TerraVoice.call("prepare", VoiceInput(kind: "note", note: text))
    if prep.needsNote == true { throw $note.needsValueError("What's the note?") }
    guard prep.ok == true, let token = prep.token else {
      return .result(dialog: "\(prep.speech ?? "I can't save that note.")")
    }
    let (yes, silent) = await TerraVoice.askYes(self, readBack: prep.readBack ?? "Save it?", action: .add)
    guard yes else {
      await TerraVoice.cancel(token, silence: silent)
      return .result(dialog: "OK, nothing saved.")
    }
    let done = try await TerraVoice.call("confirm", VoiceInput(token: token))
    return .result(dialog: "\(done.speech ?? "Saved.")")
  }
}

// MARK: - The phrases

struct TerraShortcuts: AppShortcutsProvider {
  @AppShortcutsBuilder
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: TerraNextJob(), phrases: [
      "What's my next job in \(.applicationName)",
      "What's my next job on \(.applicationName)",
      "\(.applicationName) next job",
    ])
    AppShortcut(intent: TerraDirections(), phrases: [
      "Direct me to my next job in \(.applicationName)",
      "Directions to my next job in \(.applicationName)",
      "\(.applicationName) directions",
    ])
    AppShortcut(intent: TerraJobSheet(), phrases: [
      "What's on the job sheet in \(.applicationName)",
      "Read the job sheet in \(.applicationName)",
      "\(.applicationName) job sheet",
    ])
    AppShortcut(intent: TerraLateClient(), phrases: [
      "Tell my next job I'm running late in \(.applicationName)",
      "Tell the client I'm running late in \(.applicationName)",
    ])
    AppShortcut(intent: TerraLateOffice(), phrases: [
      "Tell the office I'm running late in \(.applicationName)",
      "\(.applicationName) tell the office I'm late",
    ])
    AppShortcut(intent: TerraCallContact(), phrases: [
      "Call the site contact in \(.applicationName)",
      "Call the client in \(.applicationName)",
    ])
    AppShortcut(intent: TerraCallOffice(), phrases: [
      "Call the office in \(.applicationName)",
      "\(.applicationName) call the office",
    ])
    AppShortcut(intent: TerraAddNote(), phrases: [
      "Add a note to this job in \(.applicationName)",
      "\(.applicationName) add a note",
    ])
  }
}
