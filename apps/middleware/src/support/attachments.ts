import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ObjectReader, StoredObject } from "@avni/service";

import { ATTACHMENT_READER } from "../tokens";
import { MessagesRepository } from "./messages.repository";

/**
 * Serving one file to one signed-in Support Officer.
 *
 * **The Middleware reads and the Platform writes, and neither does the other.**
 * The Platform is handed an `ObjectWriter`, which has no `get`; this is handed
 * an `ObjectReader`, which has no `put`. The bucket policy splits the
 * credentials the same way (ticket 41), and this is the half that holds even
 * where it does not.
 *
 * The key is never taken from the caller. An Officer names a **message**, and
 * the key comes out of the row — so a Dashboard session cannot be turned into a
 * read of an arbitrary object by editing a path, and the object keys themselves
 * never leave this deployable.
 */

export type AttachmentRead =
  | ({ readonly outcome: "found" } & StoredObject)
  | { readonly outcome: "not_found" }
  /** The bucket did not answer. Distinct from a file that is not there. */
  | { readonly outcome: "unavailable" };

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  public constructor(
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(ATTACHMENT_READER) private readonly store: ObjectReader,
  ) {}

  public async read(conversationId: string, messageId: string): Promise<AttachmentRead> {
    const message = await this.messages.findById(messageId);
    // Scoped to the conversation the Officer opened. A message id belonging to
    // somebody else's conversation is a `not_found`, not a file.
    if (!message || message.conversationId !== conversationId || !message.attachment) {
      return { outcome: "not_found" };
    }

    try {
      const object = await this.store.get(message.attachment.key);
      if (!object) return { outcome: "not_found" };

      // The Customer's own filename is **not** carried out of here. It is
      // rendered to an Officer from the history, where it is text in a page;
      // putting it in a `content-disposition` header would be a
      // Customer-supplied string in a response header, and the header is
      // deliberately bare instead.
      return { outcome: "found", ...object };
    } catch (error) {
      this.logger.error({
        event: "attachment_unreadable",
        messageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "unavailable" };
    }
  }
}
