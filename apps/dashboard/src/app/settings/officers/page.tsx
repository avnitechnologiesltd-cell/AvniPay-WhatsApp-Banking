import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { formatWhen } from "../../../format";
import { currentSession } from "../../../session";
import { listOfficerSessions, listOfficers, type LiveSession } from "../../../settings";
import type { StaffAccount } from "../../../staff";
import { readingAsOfficer } from "../../guard";
import { StaffBar } from "../../staff-bar";
import { button, card, dangerButton, field, heading, muted, notice, page, subheading } from "../../ui";
import { changeRole, invite, rename, resetPassword, setAccess, signOutEverywhere } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Officer accounts, and the display names a Customer is told.
 *
 * **Administrator only, and not read-only for anybody else.** Ticket 22's role
 * table gives a Support Officer `—` on this surface rather than *read* — who
 * else can get in is not their business — so this page refuses rather than
 * rendering a version of itself with the buttons removed.
 *
 * The display name is the field with a consequence outside this screen. A
 * Customer handed to a human is told that human's name, in both directions, and
 * it is a deliberate cost rather than an oversight: the Customer learns a member
 * of staff's first name. What the Bank chooses to put in this box is therefore
 * the Bank's decision to make, and it must not need a release from us.
 */
const OfficersPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; saved?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const { problem, saved } = await searchParams;

  if (session.account.role !== "administrator") {
    return (
      <main style={page}>
        <StaffBar account={session.account} />
        <h1 style={heading}>Officers</h1>
        <p style={notice}>
          Only an Administrator may see who can sign in. This is not a permission that has been
          left off — the role does not carry it.
        </p>
        <p style={muted}>
          <Link href="/settings">Back to Settings</Link>
        </p>
      </main>
    );
  }

  const officers = await readingAsOfficer(() => listOfficers(session));

  // **What is actually signed in**, per account. Ticket 28 put `user_agent` and
  // `ip_address` on the sessions table for this and nothing read them; without
  // it, "sign out everywhere" is a button pressed without knowing whether there
  // was anything to sign out — which is the state a report of a stolen laptop
  // starts from.
  const sessions = await readingAsOfficer(() =>
    Promise.all(
      officers.map(async (officer) => [
        officer.id,
        await listOfficerSessions(session, officer.id),
      ] as const),
    ),
  );
  const held = new Map(sessions);

  return (
    <main style={page}>
      <StaffBar account={session.account} />
      <h1 style={heading}>Officers</h1>
      <p style={muted}>
        Everybody who can sign in. The display name is what a Customer is told when this person
        takes over their conversation.
      </p>

      {problem ? <p style={notice}>{problem}</p> : null}
      {saved && !problem ? <p style={muted}>Saved.</p> : null}

      {officers.map((officer) => (
        <Officer
          key={officer.id}
          officer={officer}
          viewer={session.account}
          sessions={held.get(officer.id) ?? []}
        />
      ))}

      <h2 style={subheading}>Invite somebody</h2>
      <Invitation />

      <p style={muted}>
        <Link href="/settings">Back to Settings</Link>
      </p>
    </main>
  );
};

const Officer = ({
  officer,
  viewer,
  sessions,
}: {
  officer: StaffAccount;
  viewer: StaffAccount;
  sessions: readonly LiveSession[];
}): ReactNode => (
  <div style={card}>
    <p style={{ margin: 0, fontWeight: 600 }}>
      {officer.displayName}
      {officer.disabled ? " · disabled" : ""}
      {officer.id === viewer.id ? " · you" : ""}
    </p>
    <p style={muted}>
      {officer.email} · {officer.role === "administrator" ? "Administrator" : "Support Officer"}
    </p>

    <Sessions sessions={sessions} />

    {/* **Said plainly rather than left as a puzzle.** An Administrator who has
        not enrolled cannot sign in at all, which is a state somebody will
        otherwise report as "the password does not work". */}
    {officer.role === "administrator" && !officer.mfaEnrolled ? (
      <p style={notice}>
        This Administrator has not enrolled a second factor and <strong>cannot sign in</strong>{" "}
        until they do. They enrol at <code>/enrol</code>, with their email and password. Set them a
        password under <em>Change</em> below if they do not have one they know.
      </p>
    ) : null}

    <details>
      <summary style={muted}>Change</summary>

      <form action={rename} style={{ marginTop: "0.75rem" }}>
        <input type="hidden" name="officerId" value={officer.id} />
        <label>
          Display name — what a Customer is told
          <input style={field} name="displayName" defaultValue={officer.displayName} required />
        </label>
        <p>
          <button style={button} type="submit">
            Save name
          </button>
        </p>
      </form>

      <form action={changeRole}>
        <input type="hidden" name="officerId" value={officer.id} />
        <label>
          Role
          <select style={field} name="role" defaultValue={officer.role}>
            <option value="support_officer">Support Officer</option>
            <option value="administrator">Administrator</option>
          </select>
        </label>
        <p style={muted}>
          Every Administrator is also a Support Officer. An Administrator must enrol a second
          factor before they can sign in.
        </p>
        <p>
          <button style={button} type="submit">
            Save role
          </button>
        </p>
      </form>

      <form action={resetPassword}>
        <input type="hidden" name="officerId" value={officer.id} />
        <label>
          New password
          <input style={field} name="password" type="password" autoComplete="new-password" required />
        </label>
        <p style={muted}>
          A reset ends every session this account holds. Tell them the password and let them
          change it.
        </p>
        <p>
          <button style={button} type="submit">
            Reset password
          </button>
        </p>
      </form>

      <form action={signOutEverywhere}>
        <input type="hidden" name="officerId" value={officer.id} />
        <p style={muted}>
          Ends the {sessions.length === 1 ? "session" : "sessions"} listed above. For a stolen
          laptop: their access ends now rather than in eight hours.
        </p>
        <p>
          <button style={button} type="submit" disabled={sessions.length === 0}>
            Sign out everywhere
          </button>
        </p>
      </form>

      <form action={setAccess}>
        <input type="hidden" name="officerId" value={officer.id} />
        <input type="hidden" name="disabled" value={officer.disabled ? "false" : "true"} />
        <p>
          <button style={officer.disabled ? button : dangerButton} type="submit">
            {officer.disabled ? "Let them back in" : "Disable this account"}
          </button>
        </p>
      </form>
    </details>
  </div>
);

/**
 * Where this account is signed in.
 *
 * **No token and no hash of one** — a session is named by an id that cannot be
 * used to become it. What is here is what somebody needs to recognise a session
 * they do not expect: when it was last used, and from what.
 */
const Sessions = ({ sessions }: { sessions: readonly LiveSession[] }): ReactNode => {
  if (sessions.length === 0) {
    return <p style={muted}>Not signed in anywhere.</p>;
  }

  return (
    <>
      <p style={muted}>
        Signed in on {sessions.length} {sessions.length === 1 ? "browser" : "browsers"}:
      </p>
      <ul style={{ ...muted, margin: "0 0 0.5rem", paddingLeft: "1.25rem" }}>
        {sessions.map((one) => (
          <li key={one.id}>
            Last used {formatWhen(one.lastSeenAt)}
            {one.ipAddress ? ` from ${one.ipAddress}` : ""}
            {one.userAgent ? ` · ${one.userAgent}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
};

const Invitation = (): ReactNode => (
  <form action={invite} style={card}>
    <label>
      Email
      <input style={field} name="email" type="email" required />
    </label>
    <label>
      Display name — what a Customer is told
      <input style={field} name="displayName" required />
    </label>
    <label>
      Password
      <input style={field} name="password" type="password" autoComplete="new-password" required />
    </label>
    <label>
      Role
      <select style={field} name="role" defaultValue="support_officer">
        <option value="support_officer">Support Officer</option>
        <option value="administrator">Administrator</option>
      </select>
    </label>
    <p style={muted}>
      At least twelve characters. Tell them the password and let them change it — there is no
      email from this platform, deliberately.
    </p>
    <p>
      <button style={button} type="submit">
        Create account
      </button>
    </p>
  </form>
);

export default OfficersPage;
