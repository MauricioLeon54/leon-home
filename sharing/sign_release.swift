// Maintainer-only release signing. Private key material stays in the login Keychain.
import CryptoKit
import Foundation
import Security

let service = "LEON Home release signing"
let account = "ed25519-v1"
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
func readKey(create: Bool) -> Curve25519.Signing.PrivateKey {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecSuccess, let data = result as? Data,
    let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: data)
  {
    return key
  }
  guard status == errSecItemNotFound, create else {
    fail("Release signing key unavailable; unlock the login Keychain or initialize it locally.")
  }
  let key = Curve25519.Signing.PrivateKey()
  let attributes: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
    kSecAttrSynchronizable as String: false,
    kSecValueData as String: key.rawRepresentation,
    kSecAttrLabel as String: "LEON Home application release signing",
  ]
  guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else {
    fail("Could not save the release signing key in the login Keychain.")
  }
  return key
}
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 2 || arguments.count == 3 else {
  fail(
    "Usage: LeonReleaseSigner init PUBLIC.pem | public PUBLIC.pem | sign MANIFEST.json SIGNATURE")
}
let action = arguments[0]
guard ["init", "public", "sign"].contains(action),
  action == "sign" ? arguments.count == 3 : arguments.count == 2
else { fail("Invalid signer operation.") }
let key = readKey(create: action == "init")
do {
  if action == "sign" {
    let data = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
    guard data.count <= 65_536,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      object["product"] as? String == "leon-home"
    else { fail("Only a bounded LEON Home release manifest can be signed.") }
    try key.signature(for: data).write(to: URL(fileURLWithPath: arguments[2]), options: .atomic)
    print("Release manifest signed.")
  } else {
    let prefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
    let der = prefix + key.publicKey.rawRepresentation
    let pem =
      "-----BEGIN PUBLIC KEY-----\n" + der.base64EncodedString() + "\n-----END PUBLIC KEY-----\n"
    try Data(pem.utf8).write(to: URL(fileURLWithPath: arguments[1]), options: .atomic)
    print(
      "Public key fingerprint (SHA-256 DER): "
        + SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined())
  }
} catch {
  fail("Release signing operation failed. No private key material was exported.")
}
