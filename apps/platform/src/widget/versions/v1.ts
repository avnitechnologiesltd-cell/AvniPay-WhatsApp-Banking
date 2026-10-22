/**
 * The **Widget**, version 1 — the chat panel the loader fetches at runtime.
 *
 * Everything that might ever need to change lives here rather than in the
 * Snippet, and that is the whole of [ADR-0011](../../../../../docs/adr/0011-the-snippet-is-a-loader-not-the-widget.md):
 * the Snippet inside the Bank's shipped mobile application cannot be recalled,
 * this file reaches every Customer the moment it is deployed.
 *
 * **It is served by the Platform and posts its chat to the Platform. Its
 * authorisation surfaces post to the Middleware** — the Confirmation screen, the
 * Disambiguation screen, the *"Save as"* label, PIN entry and PIN creation, at
 * an address the Middleware itself named
 * ([ADR-0007](../../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
 * Serving the code and receiving the secret stay separate, and that separation
 * is the reason it is safe for the prompt-injection surface to serve this at
 * all. Nothing below sends a Transaction PIN or a label to the endpoint the
 * chat above it uses, and there is no code path here that could.
 *
 * Plain ES5-shaped JavaScript with no build step and no dependency, because it
 * runs inside a WebView in somebody else's application and we do not know which
 * one.
 */

/**
 * Rendered verbs, and **no channel branching anywhere in here**.
 *
 * The composer says `say`, `ask`, `send` or `secure` and this renders it. It is
 * the same composer, producing the same verbs, that the WhatsApp adapter
 * renders as Graph API messages — which is the whole of what "same bot logic,
 * different rendering" means.
 */
export const WIDGET_V1_SOURCE = String.raw`(function () {
  "use strict";

  var boot = window.AvniChat;
  if (!boot || !boot.mount) return;

  var mount = boot.mount;
  var base = String(boot.base || "").replace(/\/+$/, "");
  var endpoint = base + "/widget/" + boot.version;

  var UNAVAILABLE = "Chat is not available right now. Please try again shortly.";
  var UNIDENTIFIED = "We could not confirm who you are. Please close chat and open it again.";

  var conversationId = null;

  // --- The panel -----------------------------------------------------------

  mount.textContent = "";
  var panel = el("div", "avni-chat__panel");
  var log = el("div", "avni-chat__log");
  var form = document.createElement("form");
  form.className = "avni-chat__composer";
  var input = document.createElement("input");
  input.type = "text";
  input.className = "avni-chat__input";
  input.setAttribute("aria-label", "Message");
  input.placeholder = "Ask about your account";
  var send = document.createElement("button");
  send.type = "submit";
  send.className = "avni-chat__send";
  send.textContent = "Send";

  form.appendChild(input);
  form.appendChild(send);
  panel.appendChild(log);
  panel.appendChild(form);
  mount.appendChild(panel);

  // --- Talking to the Platform --------------------------------------------

  function post(path, body) {
    return fetch(endpoint + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function open() {
    // The signed identity, forwarded exactly as the Bank's backend produced it.
    // The Widget does not read it either — nothing on this side of the
    // Middleware has any business knowing which account it names.
    return post("/conversations", { identity: boot.identity }).then(function (opened) {
      if (opened.outcome !== "opened") {
        say(UNIDENTIFIED);
        return null;
      }
      conversationId = opened.conversationId;
      return conversationId;
    });
  }

  function exchange(message) {
    var body = { conversationId: conversationId };
    if (message.said !== undefined) body.said = message.said;
    if (message.chose !== undefined) body.chose = message.chose;

    // No retry, and none is needed: a conversation lives in the Middleware's
    // database rather than in the Platform's memory, so it survives a restart
    // and is answered the same by whichever instance receives the message.
    return post("/messages", body)
      .then(function (answer) {
        // **A null reply is a Support Officer owning this conversation.** The
        // Agent has left, and what comes back instead arrives through the poll
        // below — written by a named human and delivered by the Middleware.
        render(answer.reply);
        return collect();
      })
      .catch(function () {
        say(UNAVAILABLE);
      });
  }

  // --- What a human left waiting -------------------------------------------

  // This Channel has no 24-hour window and needs no approved template. A
  // Support Officer answering at 9am does not have to reach a handset: the
  // reply is simply here when the Customer next opens the Bank's application,
  // and this is the fetch that finds it.
  //
  // The "after" parameter is the last id already drawn, so a reconnect does not
  // repeat the conversation back at the Customer.

  var lastSeen = "0";

  function collect() {
    if (!conversationId) return Promise.resolve();

    return fetch(
      endpoint +
        "/messages?conversationId=" +
        encodeURIComponent(conversationId) +
        "&after=" +
        encodeURIComponent(lastSeen)
    )
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (answer) {
        (answer.messages || []).forEach(function (message) {
          lastSeen = message.id;
          say(message.text);
        });
      })
      .catch(function () {
        // Silently. A poll that could not reach the Platform is not something to
        // interrupt a Customer about — the next one in a few seconds will.
      });
  }

  // --- Rendering the composer's verbs --------------------------------------

  function render(reply) {
    if (!reply) return;

    if (reply.verb === "say") return say(reply.text);

    if (reply.verb === "ask") {
      var asked = say(reply.question);
      var choices = el("div", "avni-chat__choices");
      reply.choices.forEach(function (choice) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "avni-chat__choice";
        button.textContent = choice.label;
        button.onclick = function () {
          choices.parentNode.removeChild(choices);
          mine(choice.label);
          exchange({ chose: choice.id });
        };
        choices.appendChild(button);
      });
      asked.appendChild(choices);
      return;
    }

    if (reply.verb === "send") {
      var link = document.createElement("a");
      link.href = reply.documentUrl;
      link.textContent = reply.caption || "Open";
      say("").appendChild(link);
      return;
    }

    if (reply.verb === "secure") {
      // A sealed authorisation surface. **It terminates at the Middleware and
      // never here**, at the address on the reply — this file was served by the
      // Platform and does not know where that is, which is the separation.
      var invited = say(reply.purpose);
      var opener = el("button", "avni-chat__choice");
      opener.type = "button";
      opener.textContent = reply.callToAction;
      opener.onclick = function () {
        opener.disabled = true;
        openSurface(reply);
      };
      invited.appendChild(opener);
      return;
    }
  }

  // --- The sealed surface ---------------------------------------------------

  // Everything a WhatsApp Flow renders, rendered here: the Confirmation screen,
  // the Disambiguation screen, the "Save as" label, PIN entry, and PIN
  // creation. Same screens, same Middleware logic, different rendering — that
  // is the whole of the difference between the two Channels.
  //
  // **The payload rule, as this side keeps it.** Every exchange below sends
  // only what the Customer typed or tapped. The amount, the account number and
  // the recipient's name are rendered from what the token points at and are
  // never sent back up; a payload that echoed them would be this handset
  // deciding what it is agreeing to.

  var surface = null;
  var pending = false;

  function openSurface(reply) {
    closeSurface();
    surface = el("div", "avni-chat__surface");
    log.appendChild(surface);
    log.scrollTop = log.scrollHeight;
    step(reply.surfaceUrl, reply.token, "INIT", "", {});
  }

  function closeSurface() {
    if (surface && surface.parentNode) surface.parentNode.removeChild(surface);
    surface = null;
  }

  function step(url, token, action, screen, data) {
    if (pending) return;
    pending = true;
    var opened = surface;

    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token, action: action, screen: screen, data: data })
    })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (answer) {
        // The Customer closed or replaced the surface while this was in flight.
        if (surface !== opened || !surface) return;

        if (answer.terminal) {
          closeSurface();
          say(read(answer.data, "message") || UNAVAILABLE);
          return;
        }
        paint(url, token, answer);
      })
      .catch(function () {
        closeSurface();
        say(UNAVAILABLE);
      })
      .then(function () {
        pending = false;
      });
  }

  function paint(url, token, answer) {
    surface.textContent = "";
    var data = answer.data || {};

    if (answer.screen === "RECIPIENT") return recipientScreen(url, token, data);
    if (answer.screen === "CONFIRM") return confirmScreen(url, token, data);

    // A screen this Widget does not render. It closes rather than drawing half
    // of one — a surface a Customer cannot finish is worse than none.
    closeSurface();
    say(read(data, "message") || UNAVAILABLE);
  }

  function recipientScreen(url, token, data) {
    var forgetting = data.purpose === "forget";
    note(forgetting ? "Choose who to remove" : "Choose who you meant", "avni-chat__surface-title");
    if (data.amount) note(read(data, "amount"), "avni-chat__surface-note");
    if (data.error_message) note(read(data, "error_message"), "avni-chat__surface-error");

    var rows = Array.isArray(data.beneficiaries) ? data.beneficiaries : [];
    rows.forEach(function (row) {
      var button = el("button", "avni-chat__row");
      button.type = "button";
      var title = el("span", "avni-chat__row-title");
      title.textContent = read(row, "title");
      var description = el("span", "avni-chat__row-description");
      description.textContent = read(row, "description");
      button.appendChild(title);
      button.appendChild(description);
      button.onclick = function () {
        // An id the server rendered, coming straight back. It selects from a
        // set the server owns and scopes to this Customer, which is the one
        // class of rendered value a payload may carry.
        step(url, token, "data_exchange", "RECIPIENT", { beneficiary_id: read(row, "id") });
      };
      surface.appendChild(button);
    });

    // Deleting is done by tapping a record and nothing else. There is no
    // account-number form on a screen that removes.
    if (forgetting) return;

    // Where every Customer's first transfer lands: a store nothing has been
    // saved to answers to nobody.
    var accountNumber = field("Account number", { inputMode: "numeric", maxLength: 10 });
    var bankName = field("Bank (leave blank for this bank)", {});
    submitButton("Continue", function () {
      step(url, token, "data_exchange", "RECIPIENT", {
        account_number: accountNumber.value,
        bank_name: bankName.value
      });
    });
  }

  function confirmScreen(url, token, data) {
    note("Confirm this transfer", "avni-chat__surface-title");
    detail("Amount", read(data, "amount"));
    detail("To", read(data, "destination_name"));
    detail("Account", read(data, "destination_account"));
    detail("Bank", read(data, "destination_bank"));
    detail("From", read(data, "source_account"));
    // Said loudly, before the PIN: the account this is going to was saved under
    // a different name than the one its own bank reports now.
    if (data.name_changed) note(read(data, "name_changed"), "avni-chat__surface-warning");
    if (data.fee_note) note(read(data, "fee_note"), "avni-chat__surface-note");
    if (data.error_message) note(read(data, "error_message"), "avni-chat__surface-error");

    // **A Customer who has never enrolled has no Transaction PIN**, and this is
    // where they choose one. Which of the two this is, is the Middleware's to
    // say — asked of the PIN store rather than of the Channel, so this renders
    // an answer rather than deciding one.
    var creating = data.pin_action === "create";
    if (creating && data.pin_note) note(read(data, "pin_note"), "avni-chat__surface-note");

    var pin = field(creating ? "Choose a Transaction PIN" : "Transaction PIN", {
      type: "password",
      inputMode: "numeric",
      maxLength: 4
    });
    var again = creating
      ? field("Enter it again", { type: "password", inputMode: "numeric", maxLength: 4 })
      : null;
    // Captured here rather than asked for in conversation, where a Customer's
    // reply would be indistinguishable from a malformed Intent to the model
    // reading it. It goes to the Middleware and nowhere else.
    var saveAs = field("Save as (optional)", { maxLength: 24 });

    submitButton(creating ? "Set PIN and send" : "Send", function () {
      step(url, token, "data_exchange", "CONFIRM", {
        pin: pin.value,
        pin_confirmation: again ? again.value : "",
        save_as: saveAs.value
      });
    });
  }

  function detail(label, value) {
    var row = el("div", "avni-chat__detail");
    var name = el("span", "avni-chat__detail-label");
    name.textContent = label;
    var said = el("span", "avni-chat__detail-value");
    said.textContent = value;
    row.appendChild(name);
    row.appendChild(said);
    surface.appendChild(row);
  }

  function field(label, options) {
    var wrap = el("label", "avni-chat__field");
    var name = el("span", "avni-chat__field-label");
    name.textContent = label;
    var input = document.createElement("input");
    input.className = "avni-chat__field-input";
    input.type = options.type || "text";
    if (options.inputMode) input.inputMode = options.inputMode;
    if (options.maxLength) input.maxLength = options.maxLength;
    wrap.appendChild(name);
    wrap.appendChild(input);
    surface.appendChild(wrap);
    return input;
  }

  function submitButton(label, onClick) {
    var button = el("button", "avni-chat__action");
    button.type = "button";
    button.textContent = label;
    button.onclick = onClick;
    surface.appendChild(button);
    return button;
  }

  /** One line inside the surface. textContent, like everything else here. */
  function note(text, className) {
    var row = el("div", className);
    row.textContent = text;
    surface.appendChild(row);
    return row;
  }

  /** One string out of what the server sent. Anything else reads as absent. */
  function read(source, key) {
    var value = source ? source[key] : null;
    return typeof value === "string" ? value : "";
  }

  function say(text) {
    return line(text, "avni-chat__message avni-chat__message--theirs");
  }

  function mine(text) {
    return line(text, "avni-chat__message avni-chat__message--mine");
  }

  function line(text, className) {
    var row = el("div", className);
    // textContent throughout. Nothing rendered here is ever parsed as markup,
    // including anything a Customer typed.
    if (text) row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    node.className = className;
    return node;
  }

  // --- Starting up ---------------------------------------------------------

  form.onsubmit = function (event) {
    event.preventDefault();
    var said = input.value.trim();
    if (!said || !conversationId) return;
    input.value = "";
    mine(said);
    exchange({ said: said });
  };

  open()
    .then(function (opened) {
      if (!opened) return;
      // On open, then on a timer. Everything a Support Officer wrote while the
      // application was closed is here waiting, and there is no window to
      // reopen and no template to send — that is WhatsApp's problem and not
      // this Channel's.
      collect();
      setInterval(collect, 5000);
    })
    .catch(function () {
      say(UNAVAILABLE);
    });
})();`;

/** Styles, served with the Widget so the Bank pastes no CSS either. */
export const WIDGET_V1_STYLES = String.raw`.avni-chat__panel{display:flex;flex-direction:column;height:100%;min-height:20rem;font:1rem/1.5 system-ui,sans-serif}
.avni-chat__log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.5rem}
.avni-chat__message{max-width:85%;padding:.5rem .75rem;border-radius:.75rem;white-space:pre-wrap}
.avni-chat__message--theirs{align-self:flex-start;background:#f1f1f4}
.avni-chat__message--mine{align-self:flex-end;background:#0b5cff;color:#fff}
.avni-chat__choices{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem}
.avni-chat__choice{padding:.375rem .75rem;border:1px solid currentColor;border-radius:999px;background:none;font:inherit;cursor:pointer}
.avni-chat__surface{align-self:stretch;display:flex;flex-direction:column;gap:.5rem;padding:.75rem;border:1px solid #c8c8d0;border-radius:.75rem;background:#fff}
.avni-chat__surface-title{font-weight:600}
.avni-chat__surface-note{color:#55555f;font-size:.875rem}
.avni-chat__surface-warning{padding:.5rem;border-radius:.5rem;background:#fff4d6}
.avni-chat__surface-error{color:#b00020}
.avni-chat__detail{display:flex;justify-content:space-between;gap:1rem}
.avni-chat__detail-label{color:#55555f}
.avni-chat__detail-value{text-align:right}
.avni-chat__row{display:flex;flex-direction:column;align-items:flex-start;gap:.125rem;padding:.5rem .75rem;border:1px solid #c8c8d0;border-radius:.5rem;background:none;font:inherit;text-align:left;cursor:pointer}
.avni-chat__row-title{font-weight:600}
.avni-chat__row-description{color:#55555f;font-size:.875rem}
.avni-chat__field{display:flex;flex-direction:column;gap:.25rem}
.avni-chat__field-label{color:#55555f;font-size:.875rem}
.avni-chat__field-input{padding:.5rem .75rem;border:1px solid #c8c8d0;border-radius:.5rem;font:inherit}
.avni-chat__action{padding:.5rem 1rem;border:0;border-radius:.5rem;background:#0b5cff;color:#fff;font:inherit;cursor:pointer}
.avni-chat__composer{display:flex;gap:.5rem;padding:.75rem;border-top:1px solid #e3e3e8}
.avni-chat__input{flex:1;padding:.5rem .75rem;border:1px solid #c8c8d0;border-radius:.5rem;font:inherit}
.avni-chat__send{padding:.5rem 1rem;border:0;border-radius:.5rem;background:#0b5cff;color:#fff;font:inherit;cursor:pointer}`;
