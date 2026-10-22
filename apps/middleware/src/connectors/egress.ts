/**
 * **Check the number, not the name.**
 *
 * An Administrator types an address into a form and the Middleware calls it. The
 * Middleware sits *inside* the Bank's network and holds every credential, so
 * that form is a way to make the Bank's own trusted server call anything at all.
 * `https://127.0.0.1:8080/admin` is unreachable from outside and trivial from
 * there; `169.254.169.254` hands out the cloud instance's own keys to whatever
 * asks.
 *
 * **Validating the address as text does not work, and this is the part that
 * looks solved when it is not.** A hostname becomes an IP address at call time
 * and whoever owns the name chooses what comes back — safe at registration,
 * `127.0.0.1` a week later. A plain `302` achieves the same with no DNS
 * involved. In both cases the check inspected a string and the connection used
 * an address.
 *
 * So this file holds two things of very different weight:
 *
 * - {@link endpointProblem} is the **cheap** check, run when an Administrator
 *   registers a Connector. It refuses the obviously wrong — plain HTTP, a
 *   credential in the URL, a literal private address, a name that means *this
 *   machine* — and it proves nothing about where the name will point tomorrow.
 * - {@link addressProblem} is the **real** one, run at connect time on the
 *   address the resolver actually returned, by `dispatcher.ts`, which then
 *   connects to that exact address and never resolves the name again.
 *
 * The allowlist is implicit: a registered endpoint is what puts a host on it,
 * and nothing unregistered can be called. The deny below is where the security
 * lives; the allowlist only bounds the blast radius.
 */

export type AddressKind =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "unreadable";

/** Everything except this is refused, which is the direction that fails safe. */
const REACHABLE: AddressKind = "public";

/**
 * What an address is, from the address itself.
 *
 * Documentation and benchmark ranges are deliberately **not** singled out. They
 * are not a path into the Bank's network, which is what this function is for,
 * and a deny list that grows to include everything unusual is one that
 * eventually refuses a Bank's real endpoint for a reason nobody can explain.
 */
export const kindOfAddress = (address: string): AddressKind => {
  const trimmed = address.trim();
  const four = readIpv4(trimmed);
  if (four) return kindOfIpv4(four);

  const six = readIpv6(trimmed);
  if (!six) return "unreadable";

  // **An IPv4-mapped address is an IPv4 address.** `::ffff:127.0.0.1` is
  // loopback wearing a different family's notation, and a check that read the
  // notation rather than the address would hand it straight to `connect`.
  const mapped = mappedIpv4(six);
  if (mapped) return kindOfIpv4(mapped);

  return kindOfIpv6(six);
};

/** Why this address may not be connected to, or nothing. */
export const addressProblem = (address: string): string | undefined => {
  const kind = kindOfAddress(address);
  if (kind === REACHABLE) return undefined;

  return kind === "unreadable"
    ? `"${address}" is not an address this can check`
    : `${address} is ${WORDS[kind]}, which is inside the Bank's own network rather than on the internet`;
};

const WORDS: Record<Exclude<AddressKind, "public" | "unreadable">, string> = {
  loopback: "this machine",
  private: "a private address",
  link_local: "a link-local address, where cloud instance credentials live",
  unspecified: "the unspecified address",
  multicast: "a multicast address",
  reserved: "a reserved address",
};

/**
 * Names that mean *somewhere only this machine can reach*, refused by name.
 *
 * They would be refused at connect time anyway — every one of them resolves
 * privately — and refusing them here means the Administrator finds out while
 * they are looking at the form rather than when the Support Agent first tries.
 */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/**
 * What is wrong with an endpoint an Administrator typed, in their own words.
 *
 * Deliberately not a promise. A hostname that reads safely here is accepted and
 * checked again, on its resolved address, on every single call.
 */
export const endpointProblem = (endpoint: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "That is not a web address. It should look like https://api.example.com/path.";
  }

  if (url.protocol !== "https:") {
    return (
      "A Connector endpoint must be HTTPS. The Bank's credential travels on this request, " +
      "and it is sent with certificate verification on."
    );
  }

  if (url.username !== "" || url.password !== "") {
    return "Take the credential out of the address. It is entered separately, and stored sealed.";
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) return "That address names no host.";

  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${url.hostname} is inside the Bank's own network. A Connector calls out to the internet.`;
  }

  // A literal address can be judged here and now. A name cannot, and is not.
  const kind = kindOfAddress(host);
  if (kind !== "unreadable" && kind !== REACHABLE) return addressProblem(host);

  return undefined;
};

// --- Reading an address ------------------------------------------------------

const readIpv4 = (address: string): readonly number[] | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;

  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number.parseInt(part, 10) : Number.NaN,
  );
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : undefined;
};

const kindOfIpv4 = (octets: readonly number[]): AddressKind => {
  const [a = 0, b = 0] = octets;

  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  // Carrier-grade NAT: another operator's internal space, and reachable from
  // inside a good many hosted networks.
  if (a === 100 && b >= 64 && b <= 127) return "private";
  // Benchmarking, and inter-network testing. Internal by construction.
  if (a === 198 && (b === 18 || b === 19)) return "private";
  // Link-local, which is where `169.254.169.254` lives.
  if (a === 169 && b === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";

  return "public";
};

/** Eight hextets, or nothing. Handles `::` and a trailing dotted quad. */
const readIpv6 = (address: string): readonly number[] | undefined => {
  const zone = address.indexOf("%");
  const bare = zone === -1 ? address : address.slice(0, zone);
  if (bare.length === 0 || !/^[0-9a-f:.]+$/i.test(bare)) return undefined;

  const halves = bare.split("::");
  if (halves.length > 2) return undefined;

  const readGroups = (text: string): readonly number[] | undefined => {
    if (text.length === 0) return [];

    const parts = text.split(":");
    const groups: number[] = [];

    for (const [index, part] of parts.entries()) {
      // A dotted quad is only ever the last thing, and stands for two hextets.
      if (part.includes(".")) {
        if (index !== parts.length - 1) return undefined;
        const four = readIpv4(part);
        if (!four) return undefined;
        groups.push(((four[0] ?? 0) << 8) | (four[1] ?? 0), ((four[2] ?? 0) << 8) | (four[3] ?? 0));
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }

    return groups;
  };

  const head = readGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? readGroups(halves[1] ?? "") : [];
  if (!head || !tail) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;

  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
};

/** The IPv4 address inside a mapped or compatible IPv6 one, if there is one. */
const mappedIpv4 = (groups: readonly number[]): readonly number[] | undefined => {
  const leading = groups.slice(0, 5).every((group) => group === 0);
  if (!leading) return undefined;

  // `::ffff:a.b.c.d` (mapped) and `::a.b.c.d` (the deprecated compatible form).
  const marker = groups[5];
  if (marker !== 0xffff && marker !== 0) return undefined;

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff];

  // `::` and `::1` are not IPv4 addresses; they are answered by the v6 rules.
  return marker === 0 && high === 0 && low <= 1 ? undefined : octets;
};

const kindOfIpv6 = (groups: readonly number[]): AddressKind => {
  const [first = 0] = groups;

  if (groups.every((group) => group === 0)) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  // fc00::/7 — unique local, the v6 counterpart of 10/8.
  if ((first & 0xfe00) === 0xfc00) return "private";
  // fe80::/10 — link local.
  if ((first & 0xffc0) === 0xfe80) return "link_local";
  // ff00::/8 — multicast.
  if ((first & 0xff00) === 0xff00) return "multicast";

  return "public";
};
