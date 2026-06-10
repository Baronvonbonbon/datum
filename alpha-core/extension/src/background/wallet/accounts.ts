// Multi-account state.
//
// Each account corresponds to one Ethereum-compatible address the
// wallet can sign for. Two kinds:
//
//   - "hd"        derived from the BIP-39 root mnemonic at
//                 m/44'/60'/0'/0/N. Recoverable from the phrase alone.
//   - "imported"  a raw 0x-private-key the user pasted. NOT recoverable
//                 from the mnemonic; the popup surfaces a warning so the
//                 user knows to back this up separately.
//
// Account *metadata* lives outside the vault ciphertext so the popup
// can render the account list without unlocking. Account *key material*
// (HD seed for derivation, or raw private key for imported) lives
// inside the encrypted payload — see keystore.ts VaultPayload.

export type AccountMeta =
  | {
      source: "hd";
      /// EOA address, lower-case 0x-prefixed.
      address: string;
      /// BIP-32 path index — pathForAccount(derivationIndex) = full path.
      derivationIndex: number;
      /// User-supplied label. Empty string allowed; UI shows the
      /// truncated address as fallback.
      label: string;
      createdAt: number;
    }
  | {
      source: "imported";
      address: string;
      /// No derivation — this key bypasses BIP-32.
      derivationIndex: null;
      label: string;
      createdAt: number;
    };

/// Build the canonical first account meta for a freshly generated
/// HD wallet. Always derivationIndex=0, label="Account 1".
export function defaultFirstAccount(address: string): AccountMeta {
  return {
    source: "hd",
    address: lowercaseAddress(address),
    derivationIndex: 0,
    label: "Account 1",
    createdAt: Date.now(),
  };
}

/// Compute the next HD derivation index given an existing account list.
/// We always pick `max(existing HD index) + 1` rather than `accounts.length`
/// so removing intermediate accounts doesn't shift derivation, and adding
/// after a gap doesn't reuse an old index.
export function nextHdIndex(accounts: AccountMeta[]): number {
  let max = -1;
  for (const a of accounts) {
    if (a.source === "hd" && a.derivationIndex > max) max = a.derivationIndex;
  }
  return max + 1;
}

/// Add a new HD account to the list. Caller must have already derived
/// the address via deriveAddress(phrase, "", index) in the offscreen
/// host. Returns the new list (immutable update).
export function appendHdAccount(
  accounts: AccountMeta[],
  address: string,
  derivationIndex: number,
  label?: string
): AccountMeta[] {
  const addr = lowercaseAddress(address);
  if (accounts.some((a) => a.address === addr)) {
    throw new Error(`account ${addr} already in list`);
  }
  const labelText = label ?? `Account ${accounts.length + 1}`;
  return [
    ...accounts,
    {
      source: "hd",
      address: addr,
      derivationIndex,
      label: labelText,
      createdAt: Date.now(),
    },
  ];
}

/// Add an imported (raw-key) account. The actual key material lives in
/// the encrypted vault payload (`importedKeys[address]`); this only
/// records the metadata.
export function appendImportedAccount(
  accounts: AccountMeta[],
  address: string,
  label?: string
): AccountMeta[] {
  const addr = lowercaseAddress(address);
  if (accounts.some((a) => a.address === addr)) {
    throw new Error(`account ${addr} already in list`);
  }
  const labelText = label ?? `Imported ${countImported(accounts) + 1}`;
  return [
    ...accounts,
    {
      source: "imported",
      address: addr,
      derivationIndex: null,
      label: labelText,
      createdAt: Date.now(),
    },
  ];
}

/// Remove an account by address. Errors if removing would empty the
/// list — there must always be at least one account.
export function removeAccount(
  accounts: AccountMeta[],
  address: string
): AccountMeta[] {
  const addr = lowercaseAddress(address);
  if (accounts.length <= 1) {
    throw new Error("cannot remove the last account");
  }
  const next = accounts.filter((a) => a.address !== addr);
  if (next.length === accounts.length) {
    throw new Error(`account ${addr} not found`);
  }
  return next;
}

/// Rename an account by address. Empty label is allowed (popup falls
/// back to a truncated-address display in that case).
export function setLabel(
  accounts: AccountMeta[],
  address: string,
  label: string
): AccountMeta[] {
  const addr = lowercaseAddress(address);
  let found = false;
  const next = accounts.map((a) => {
    if (a.address === addr) {
      found = true;
      return { ...a, label } as AccountMeta;
    }
    return a;
  });
  if (!found) throw new Error(`account ${addr} not found`);
  return next;
}

/// Look up an account by address. Returns undefined when the address
/// isn't in the list.
export function findAccount(
  accounts: AccountMeta[],
  address: string
): AccountMeta | undefined {
  const addr = lowercaseAddress(address);
  return accounts.find((a) => a.address === addr);
}

/// Resolve the active account by index. Throws if `activeIndex` is out
/// of range — that's a vault-corruption signal rather than a recoverable
/// user error.
export function activeAccount(
  accounts: AccountMeta[],
  activeIndex: number
): AccountMeta {
  const a = accounts[activeIndex];
  if (!a) {
    throw new Error(
      `activeIndex ${activeIndex} out of range (have ${accounts.length} accounts)`
    );
  }
  return a;
}

/// Compute a new activeIndex after the list changes. Used by remove()
/// so removing the currently-active account doesn't leave the pointer
/// dangling. Clamps to [0, newLength-1] and prefers the same numeric
/// position when possible.
export function clampActiveIndex(
  newAccounts: AccountMeta[],
  prevActive: number
): number {
  if (newAccounts.length === 0) return 0;
  if (prevActive < 0) return 0;
  if (prevActive >= newAccounts.length) return newAccounts.length - 1;
  return prevActive;
}

function lowercaseAddress(addr: string): string {
  return addr.toLowerCase();
}

function countImported(accounts: AccountMeta[]): number {
  return accounts.reduce((n, a) => (a.source === "imported" ? n + 1 : n), 0);
}
