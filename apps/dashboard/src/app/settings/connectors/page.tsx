import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  PARAMETER_ROWS,
  parameterField,
  readConnectors,
  type Connector,
  type ConnectorParameter,
} from "../../../connectors";
import { formatWhen } from "../../../format";
import { currentSession } from "../../../session";
import { readingAsOfficer } from "../../guard";
import { StaffBar } from "../../staff-bar";
import {
  button,
  card,
  dangerButton,
  field,
  heading,
  muted,
  notice,
  page,
  subheading,
} from "../../ui";
import { change, register, retire } from "./actions";

/** Never cached. Reading the registry is an audited act, like everything here. */
export const dynamic = "force-dynamic";

/**
 * **Where the Bank gives its Support Agent a new capability.**
 *
 * A Connector is an HTTP API the Bank registers at runtime: an endpoint, a
 * credential, a description and one **Gated** checkbox. The platform never
 * learns what the API does or where it is hosted, and **the Middleware makes
 * every call**, so a Bank credential pasted into this form never comes to rest
 * in the deployable that reads Customer text into a model
 * ([ADR-0005](../../../../../../docs/adr/0005-connector-execution-and-verification-live-in-the-middleware.md),
 * [ADR-0006](../../../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 *
 * v1 ships with **zero Connectors registered**, and this screen ships anyway. A
 * Bank with none is an ordinary Bank rather than an incomplete one.
 *
 * Three things on this page are load-bearing and are said out loud on it, because
 * the person filling it in is the only one who can get them right:
 *
 * - **The description is read by the model.** A careless one causes wrong calls
 *   and a hostile one is prompt injection with an API behind it.
 * - **The credential cannot be read back.** Not by us, not by the Dashboard, not
 *   by the Administrator who typed it. Changing it means typing a new one.
 * - **A parameter may not name the Customer.** The Middleware sends the account
 *   number from the conversation; the Support Agent cannot supply one, and that
 *   is what makes a wrong call a failed call rather than a stranger's card being
 *   blocked.
 */
const ConnectorsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; saved?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const administrator = session.account.role === "administrator";
  const { problem, saved } = await searchParams;
  const { connectors, crowdedAt } = await readingAsOfficer(() => readConnectors(session));

  const active = connectors.filter((connector) => connector.status === "active");
  const retired = connectors.filter((connector) => connector.status === "retired");

  return (
    <main style={page}>
      <StaffBar account={session.account} />
      <h1 style={heading}>Connectors</h1>
      <p style={muted}>
        {administrator
          ? "APIs of yours the Support Agent may call for a Customer. Every call is recorded."
          : "APIs of yours the Support Agent may call for a Customer. Only an Administrator may change these."}
      </p>

      {/* Rendered as text, never as markup. It came back on the URL, so the one
          person who can put anything in it is the person reading it. */}
      {problem ? <p style={notice}>{problem}</p> : null}
      {saved && !problem ? <p style={muted}>Saved.</p> : null}

      {active.length >= crowdedAt ? (
        <p style={notice}>
          {active.length} Connectors are registered. The Support Agent picks the right one less
          often as the list grows — above about {crowdedAt}, retiring the ones nobody uses is
          worth more than adding another.
        </p>
      ) : null}

      <h2 style={subheading}>Registered</h2>
      {active.length === 0 ? (
        <p style={muted}>
          None. The Support Agent answers from the Library and hands anything else to a person,
          which is a complete way to run this.
        </p>
      ) : (
        active.map((connector) => (
          <Registered
            key={connector.id}
            connector={connector}
            administrator={administrator}
          />
        ))
      )}

      {administrator ? (
        <>
          <h2 style={subheading}>Register one</h2>
          <Registration />
        </>
      ) : null}

      {retired.length > 0 ? (
        <>
          <h2 style={subheading}>Retired</h2>
          <p style={muted}>
            Out of the Support Agent&rsquo;s reach. Kept so the record of what was called through
            them still reads.
          </p>
          {retired.map((connector) => (
            <div key={connector.id} style={card}>
              <strong>{connector.name}</strong>
              <p style={muted}>
                {connector.endpoint} · retired{" "}
                {connector.retiredAt ? formatWhen(connector.retiredAt) : ""}
              </p>
            </div>
          ))}
        </>
      ) : null}
    </main>
  );
};

const Registered = ({
  connector,
  administrator,
}: {
  connector: Connector;
  administrator: boolean;
}): ReactNode => (
  <div style={card}>
    <strong>{connector.name}</strong>
    {connector.gated ? <span style={muted}> · Gated</span> : null}
    <p style={muted}>{connector.description}</p>
    <p style={muted}>
      {connector.endpoint} · credential in <code>{connector.credentialHeader}</code>, entered{" "}
      {formatWhen(connector.credentialSetAt)}
    </p>
    <Parameters parameters={connector.parameters} />

    {administrator ? (
      <details>
        <summary>Change</summary>
        <form action={change}>
          <input type="hidden" name="connectorId" value={connector.id} />
          <Fields connector={connector} />
          <label>
            New credential — leave empty to keep the one already stored
            <input style={field} name="credential" type="password" autoComplete="off" />
          </label>
          <p>
            <button style={button} type="submit">
              Save changes
            </button>
          </p>
        </form>

        <form action={retire}>
          <input type="hidden" name="connectorId" value={connector.id} />
          <p style={muted}>
            The Support Agent stops being offered it in the very next turn.
          </p>
          <p>
            <button style={dangerButton} type="submit">
              Retire this Connector
            </button>
          </p>
        </form>
      </details>
    ) : null}
  </div>
);

const Parameters = ({
  parameters,
}: {
  parameters: readonly ConnectorParameter[];
}): ReactNode => {
  if (parameters.length === 0) return <p style={muted}>Takes no parameters.</p>;

  return (
    <ul style={{ ...muted, margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
      {parameters.map((parameter) => (
        <li key={parameter.name}>
          <code>{parameter.name}</code> · {parameter.type}
          {parameter.required ? " · required" : ""}
          {parameter.description ? ` — ${parameter.description}` : ""}
        </li>
      ))}
    </ul>
  );
};

const Registration = (): ReactNode => (
  <form action={register} style={card}>
    <label>
      Name — what the Support Agent calls it, like <code>block_card</code>
      <input style={field} name="name" required />
    </label>
    <Fields />
    <label>
      Credential
      <input style={field} name="credential" type="password" autoComplete="off" required />
    </label>
    <p style={muted}>
      Entered once. Nobody can read it back afterwards — not this screen, not us, not you.
      Changing it means entering a new one.
    </p>
    <p>
      <button style={button} type="submit">
        Register
      </button>
    </p>
  </form>
);

/** The fields a registration and a change have in common, in one place. */
const Fields = ({ connector }: { connector?: Connector }): ReactNode => (
  <>
    <label>
      What it does, in one line
      <input style={field} name="description" defaultValue={connector?.description} required />
    </label>
    <p style={muted}>
      <strong>The Support Agent reads this to decide when to call it.</strong> Say what it does
      and when to use it, and nothing else — anything written here is text a model acts on, so
      it is treated as untrusted and never as an instruction to us.
    </p>

    <label>
      Endpoint
      <input
        style={field}
        name="endpoint"
        type="url"
        placeholder="https://api.yourbank.example/v1/cards/block"
        defaultValue={connector?.endpoint}
        required
      />
    </label>
    <p style={muted}>
      HTTPS only. We always send a <code>POST</code> with a JSON body — your field names are the
      ones you declare below, inside our envelope, beside the account number we fill in. An
      address inside your own network is refused, and so is one that resolves to one when the
      call is made.
    </p>

    <label>
      Credential header
      <input
        style={field}
        name="credentialHeader"
        defaultValue={connector?.credentialHeader ?? "authorization"}
        required
      />
    </label>

    <label>
      <input
        type="checkbox"
        name="gated"
        value="on"
        defaultChecked={connector?.gated ?? true}
      />{" "}
      Gated — take the Customer&rsquo;s Transaction PIN before every call
    </label>
    <p style={muted}>
      Leave this on for anything that changes something. It draws on the same three attempts and
      one-hour lockout a transfer does, and it is taken every time rather than once per
      conversation. <strong>A change to a contact detail must re-verify against the contact
      already on record</strong> — we cannot enforce that from outside your API, so a Connector
      that changes a phone number or an email needs this on and needs your own check behind it.
    </p>

    <h3 style={{ ...subheading, margin: "1.25rem 0 0.5rem" }}>Parameters</h3>
    <p style={muted}>
      The fields we send inside <code>parameters</code>, under your own names. Arguments that do
      not match are refused rather than corrected — the Customer gets a person instead of a call
      with a guessed value in it. <strong>Nothing here may name the Customer</strong>: the
      account number comes from the conversation, and a field called{" "}
      <code>account_number</code> is refused.
    </p>
    {Array.from({ length: PARAMETER_ROWS }, (_, index) => (
      <ParameterRow key={index} index={index} parameter={connector?.parameters[index]} />
    ))}
  </>
);

const ParameterRow = ({
  index,
  parameter,
}: {
  index: number;
  parameter?: ConnectorParameter;
}): ReactNode => (
  <div style={{ display: "flex", gap: "0.5rem", alignItems: "end", margin: "0 0 0.5rem" }}>
    <label style={{ flex: "1 1 30%" }}>
      Field name
      <input style={field} name={parameterField(index, "name")} defaultValue={parameter?.name} />
    </label>
    <label style={{ flex: "0 0 8rem" }}>
      Type
      <select
        style={field}
        name={parameterField(index, "type")}
        defaultValue={parameter?.type ?? "string"}
      >
        <option value="string">Text</option>
        <option value="number">Number</option>
        <option value="boolean">True or false</option>
      </select>
    </label>
    <label style={{ flex: "1 1 40%" }}>
      What it is
      <input
        style={field}
        name={parameterField(index, "description")}
        defaultValue={parameter?.description}
      />
    </label>
    <label style={{ flex: "0 0 6rem", paddingBottom: "0.5rem" }}>
      <input
        type="checkbox"
        name={parameterField(index, "required")}
        defaultChecked={parameter?.required ?? false}
      />{" "}
      Required
    </label>
  </div>
);

export default ConnectorsPage;
