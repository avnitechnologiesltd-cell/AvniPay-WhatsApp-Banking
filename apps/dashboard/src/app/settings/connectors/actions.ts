"use server";

import {
  changeConnector,
  changesFrom,
  registerConnector,
  registrationFrom,
  retireConnector,
} from "../../../connectors";
import { signedIn, writing, type Landing } from "../acting";

/**
 * Registering a Connector, and the two things that make it different from every
 * other form on the Settings surface.
 *
 * It **grants the Support Agent a capability** — an API it may call on a
 * Customer's behalf — and with **Gated** ticked it registers something a
 * Customer's Transaction PIN will authorise. That is why it is Administrator
 * only, and why the credential leaves this process once and is never asked for
 * again.
 *
 * Everything that decides whether a registration is safe is checked in the
 * Middleware: the endpoint policy, the rule that a parameter may not name the
 * Customer, and the capability itself. What comes back is a sentence, which the
 * page shows. What the *form* means is in `connectors.ts`, where it is tested —
 * these three functions are the plumbing and nothing else.
 */

const LANDING: Landing = {
  saved: "/settings/connectors?saved=yes",
  refused: (problem) => `/settings/connectors?problem=${encodeURIComponent(problem)}`,
  forbidden: "Only an Administrator may register a Connector.",
};

export const register = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(() => registerConnector(session, registrationFrom(form)), LANDING);
};

export const change = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () => changeConnector(session, String(form.get("connectorId") ?? ""), changesFrom(form)),
    LANDING,
  );
};

/**
 * Takes it out of the Support Agent's reach, in the very next turn.
 *
 * Retired rather than deleted: every audit row about a dispatch through it names
 * it, and evidence with a dangling reference is evidence nobody can read back.
 */
export const retire = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(() => retireConnector(session, String(form.get("connectorId") ?? "")), LANDING);
};
