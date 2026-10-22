import type { Intent, TransactionPeriod } from "@avni/intent";

import { respondJson, startFake, type FakeService } from "./server";

/**
 * Groq's OpenAI-compatible chat completions endpoint.
 *
 * The valuable thing this fake gives a test is not the answer — it is the
 * **question**. `calls` records exactly what was sent to the model, which is
 * where "only `said` text is ever shown to it" and "the prompt is ordered
 * stable-first" become assertable rather than asserted.
 *
 * It deliberately refuses a request that does not ask for constrained decoding.
 * Intent resolution without `strict: true` is a money path relying on a model
 * to produce well-formed JSON, and the test should fail loudly if that ever
 * regresses.
 */

export interface GroqCall {
  readonly model: string;
  readonly temperature: number | undefined;
  readonly reasoningEffort: string | undefined;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly hasTools: boolean;
  /** The tools offered, by name. The Support Agent has exactly one. */
  readonly toolNames: readonly string[];
  readonly schemaName: string | undefined;
  readonly strict: boolean;
  /** Everything the model was shown, in order, as one string. */
  readonly prompt: string;
}

/**
 * One section, as the Support Agent's tool handed it back.
 *
 * The fake parses the tool result rather than being told what was retrieved,
 * which is what makes the default below assert something real: the words it
 * answers with came out of the Library, through the Middleware, over HTTP.
 */
export interface FakeRetrievedSection {
  readonly document: string;
  readonly section: string;
  readonly versionDate: string;
  readonly text: string;
}

/**
 * What the Support Agent does on one round: reach for the Library, or speak.
 *
 * Those are the only two moves it has, which is the tool-calling loop reduced to
 * the thing a test cares about.
 */
export type SupportAct =
  | { readonly search: string }
  /**
   * Reach for a **Connector**, by the tool name it was offered under.
   *
   * The name is deliberately not checked against the offered list: a model
   * calling a tool that does not exist is a real failure mode at ~68%, and a
   * fake that could not produce one would leave it untested.
   */
  | { readonly call: string; readonly arguments?: Readonly<Record<string, unknown>> }
  | { readonly say: string };

/** What the fake knows about the turn it is answering. */
export interface SupportRound {
  /** The last thing the Customer said. */
  readonly said: string;
  /** What came back from `search_library`, or `undefined` before it was called. */
  readonly retrieved: readonly FakeRetrievedSection[] | undefined;
  /** What a Connector answered, or `undefined` before one was called. */
  readonly returned: readonly string[] | undefined;
  readonly call: GroqCall;
}

export interface FakeGroqOptions {
  readonly apiKey: string;
  /**
   * Turns what the Customer said into the Intent this fake answers with.
   * Returning `undefined` answers as the real thing does when it cannot fit the
   * request to the schema — with a variant the caller must still handle.
   */
  readonly resolve?: (said: string, call: GroqCall) => Intent | undefined;
  /** How the Support Agent behaves. See {@link defaultSupport}. */
  readonly support?: (round: SupportRound) => SupportAct;
}

export interface FakeGroq extends FakeService {
  readonly calls: readonly GroqCall[];
  /** Only the Support Agent's calls — the ones with a tool on them. */
  readonly supportCalls: readonly GroqCall[];
  /** Change the answer mid-test without restarting the fake. */
  readonly setResolver: (resolve: (said: string, call: GroqCall) => Intent | undefined) => void;
  /** Make the Support Agent misbehave, which is most of what there is to test. */
  readonly setSupport: (support: (round: SupportRound) => SupportAct) => void;
}

interface ChatRequestBody {
  model?: string;
  temperature?: number;
  reasoning_effort?: string;
  messages?: { role?: string; content?: string | null }[];
  tools?: { function?: { name?: string } }[];
  response_format?: {
    type?: string;
    json_schema?: {
      name?: string;
      strict?: boolean;
      schema?: Record<string, unknown>;
    };
  };
}

/**
 * Enough of a default that the two read journeys write naturally.
 *
 * A crude regex, and deliberately so: the fake stands in for a constrained
 * model call, not for its judgement. History is matched first because *"how
 * much did I spend"* is a question about transactions that contains *"how
 * much"*.
 */
const defaultResolve = (said: string): Intent | undefined => {
  // Matched first and matched tightly. Handoff trigger 2 fires on somebody
  // *asking* for a person, never on a request that merely looks hard — so the
  // pattern names the ways people ask rather than trying to detect difficulty.
  if (
    /\bhuman\b|\breal person\b|\bcustomer (care|service)\b|\b(speak|talk|chat) (to|with) (a |an )?(person|someone|somebody|agent|advisor|representative|staff)\b/i.test(
      said,
    )
  ) {
    return { kind: "talk_to_human" };
  }
  if (/transaction|history|statement|recent|spen[dt]|last (week|month)|today/i.test(said)) {
    return { kind: "list_transactions", period: periodIn(said) };
  }
  if (/balance|how much|what.*have|money.*left/i.test(said)) return { kind: "check_balance" };
  // **A question rather than an instruction**, which is what the Support Agent
  // takes. The real resolver's prompt draws the same line and it is what stops
  // *"what do you charge to send to GTB"* resolving to a transfer with an
  // invented amount in it.
  //
  // Matched *last* and by shape rather than by topic, for the same reason the
  // rest of this function is crude: the fake stands in for a constrained model
  // call, not for its judgement. Anything that is neither an instruction it
  // knows nor question-shaped still comes back `undefined`, which is the model
  // answering outside the union.
  if (/\?\s*$|^(what|how|why|when|where|who|which|can i|could i|do you|does|did|is|are|should i|hi|hello|hey|good (morning|afternoon|evening))\b/i.test(said)) {
    return { kind: "ask_support" };
  }
  return undefined;
};

const periodIn = (said: string): TransactionPeriod => {
  if (/today/i.test(said)) return "today";
  if (/week/i.test(said)) return "last_week";
  if (/three months|3 months|quarter/i.test(said)) return "last_three_months";
  return "last_month";
};

/**
 * How the Support Agent behaves unless a test says otherwise.
 *
 * **It searches, then it answers with what came back — verbatim.** That is not
 * laziness dressed up: an answer composed from the retrieved text is *grounded
 * by construction*, so a test asserting that a Customer was told the Bank's
 * actual policy is asserting that the words travelled out of Postgres, through
 * the Middleware, over HTTP and into the reply. A fake that made a sentence up
 * would be asserting the fake.
 *
 * The interesting tests override this, because every rule on this slice is a
 * rule about a model that misbehaves.
 */
const defaultSupport = (round: SupportRound): SupportAct => {
  if (round.retrieved === undefined) {
    // **Whether to look at all is the one judgement this has to stand in for**,
    // and the system prompt draws the line in the same place: search before
    // saying anything about the bank's policies, fees, limits or products.
    //
    // A greeting is not one of those, and it matters that this is modelled
    // rather than glossed. A Library with nothing in it means the Agent answers
    // from its own instructions and hands off every *policy* question — coherent
    // and honest on day one. An Agent that searched for "hello", found nothing
    // and summoned a human would not be.
    return ABOUT_THE_BANK.test(round.said)
      ? { search: round.said }
      : { say: "I am an AI support agent for the bank. What can I help you with?" };
  }

  const first = round.retrieved[0];
  return { say: first ? first.text : "I cannot confirm that." };
};

const ABOUT_THE_BANK =
  /fee|charge|cost|limit|rate|polic|tariff|how long|when will|open(ing)?|clos|loan|interest|require|document|bvn|kyc|statement|nip|nuban|transfer/i;

/** Whatever came back from a tool this turn, parsed out of the messages. */
const toolResults = (
  messages: readonly { readonly role: string; readonly content: string }[],
): {
  retrieved: readonly FakeRetrievedSection[] | undefined;
  returned: readonly string[] | undefined;
} => {
  const parsed = messages
    .filter((message) => message.role === "tool")
    .map((message) => {
      try {
        return JSON.parse(message.content) as {
          sections?: FakeRetrievedSection[];
          connector?: string;
          result?: string;
        };
      } catch {
        return {};
      }
    });

  // The two are told apart by what is in them rather than by counting rounds,
  // so a turn that searched *and* called a Connector reports both — and a turn
  // that did neither reports `undefined` twice, which is what "before it was
  // called" means to the behaviours above.
  const searches = parsed.filter((result) => result.sections !== undefined);
  const calls = parsed.filter((result) => result.connector !== undefined);

  return {
    retrieved:
      searches.length === 0
        ? undefined
        : searches.flatMap((result) => result.sections ?? []),
    returned: calls.length === 0 ? undefined : calls.map((result) => result.result ?? ""),
  };
};

export const startFakeGroq = async (options: FakeGroqOptions): Promise<FakeGroq> => {
  const calls: GroqCall[] = [];
  let resolve = options.resolve ?? defaultResolve;
  let support = options.support ?? defaultSupport;

  const service = await startFake((request, response) => {
    if (request.headers["authorization"] !== `Bearer ${options.apiKey}`) {
      respondJson(response, 401, { error: { message: "Invalid API Key", type: "invalid_request_error" } });
      return;
    }
    if (!request.path.endsWith("/chat/completions")) {
      respondJson(response, 404, { error: { message: `no fake for ${request.path}` } });
      return;
    }

    const body = (request.body ?? {}) as ChatRequestBody;
    const messages = (body.messages ?? []).map((message) => ({
      role: message.role ?? "",
      content: message.content ?? "",
    }));

    const call: GroqCall = {
      model: body.model ?? "",
      temperature: body.temperature,
      reasoningEffort: body.reasoning_effort,
      messages,
      hasTools: (body.tools?.length ?? 0) > 0,
      toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
      schemaName: body.response_format?.json_schema?.name,
      strict: body.response_format?.json_schema?.strict === true,
      prompt: messages.map((message) => message.content).join("\n"),
    };
    calls.push(call);

    // Structured output and tool use are mutually exclusive on Groq. A caller
    // asking for both is a caller that would fail against the real provider —
    // and it is the constraint that forces the Orchestration Layer and the
    // Support Agent to be two separate calls in the first place.
    // **Groq refuses a schema whose root is a union.** Reproduced here because
    // the fake being more permissive than the real thing is how a schema that
    // no Customer message could ever resolve under passed every test: this
    // exact 400 was live, on every inbound message, with a green suite.
    const schema = body.response_format?.json_schema?.schema;
    if (body.response_format?.type === "json_schema" && schema) {
      const rootIsUnion = ["anyOf", "oneOf", "enum", "not"].some((key) => key in schema);
      if (rootIsUnion || schema["type"] !== "object") {
        respondJson(response, 400, {
          error: {
            message:
              "invalid JSON schema for response_format: schema must have type 'object' and not " +
              "have 'oneOf'/'anyOf'/'enum'/'not' at the top level.",
            type: "invalid_request_error",
            param: "response_format",
          },
        });
        return;
      }
    }

    if (call.hasTools && body.response_format?.type === "json_schema") {
      respondJson(response, 400, {
        error: { message: "response_format is not supported with tools", type: "invalid_request_error" },
      });
      return;
    }

    // --- The Support Agent: tools, and no schema ------------------------------
    if (call.hasTools) {
      const said = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const act = support({ said, ...toolResults(messages), call });

      const toolCall =
        "search" in act
          ? { name: "search_library", arguments: JSON.stringify({ query: act.search }) }
          : "call" in act
            ? { name: act.call, arguments: JSON.stringify(act.arguments ?? {}) }
            : undefined;

      respondJson(response, 200, {
        id: `chatcmpl-fake-${calls.length}`,
        object: "chat.completion",
        model: call.model,
        choices: [
          {
            index: 0,
            message: toolCall
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: `call_${calls.length}`, type: "function", function: toolCall },
                  ],
                }
              : { role: "assistant", content: "say" in act ? act.say : "" },
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      return;
    }

    // --- Intent resolution: a schema, and no tools ----------------------------
    if (!call.strict) {
      respondJson(response, 400, {
        error: {
          message: "this fake refuses unconstrained decoding on the Intent path",
          type: "invalid_request_error",
        },
      });
      return;
    }

    const said = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    const intent = resolve(said, call);

    respondJson(response, 200, {
      id: `chatcmpl-fake-${calls.length}`,
      object: "chat.completion",
      model: call.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            // `strict: true` guarantees the shape and never the values, so an
            // unresolvable request still comes back as a well-formed variant.
            content: JSON.stringify(intent ?? { kind: "unresolved" }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  return {
    ...service,
    calls,
    get supportCalls() {
      return calls.filter((call) => call.hasTools);
    },
    setResolver: (next) => {
      resolve = next;
    },
    setSupport: (next) => {
      support = next;
    },
  };
};
