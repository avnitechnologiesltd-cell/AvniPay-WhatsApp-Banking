import { randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Attachment } from "@avni/platform-channels";
import { WhatsAppMedia } from "@avni/platform-channels";
import type { ObjectWriter } from "@avni/service";

import type { StoredAttachment } from "./middleware.client";
import { ATTACHMENT_WRITER, WHATSAPP_MEDIA } from "./tokens";

/**
 * The courier that moves a Customer's file out of this deployable.
 *
 * **It never opens one.** Bytes arrive from WhatsApp's media API and go
 * straight into object storage, and what this returns is a key — not a path
 * anything here can follow, because the credential it was given is an
 * `ObjectWriter` and an `ObjectWriter` has no `get`. The Orchestration Layer is
 * told a file exists and nothing more, which is the whole rule: a document
 * handed to the layer running the LLM is an injection vector with a file
 * extension, and the Customer chooses the filename too.
 *
 * **The key is minted here and owes nothing to the file.** Not the filename,
 * not the media id, not a hash of the contents — a Customer-supplied string in
 * an object key is a path traversal waiting for a bucket that normalises
 * differently from the code that wrote it.
 */
@Injectable()
export class AttachmentCourier {
  private readonly logger = new Logger(AttachmentCourier.name);

  public constructor(
    @Inject(WHATSAPP_MEDIA) private readonly media: WhatsAppMedia,
    @Inject(ATTACHMENT_WRITER) private readonly store: ObjectWriter,
  ) {}

  /**
   * Moves the file, and answers `undefined` if it could not.
   *
   * A failure is not fatal to the turn. The Customer still gets an answer and
   * an Officer still gets the conversation — they simply get it without the
   * attachment, which is a worse Handoff and a much better one than a webhook
   * that 500s because a bucket was briefly unreachable.
   */
  public async carry(
    conversationId: string,
    attachment: Attachment,
  ): Promise<StoredAttachment | undefined> {
    const fetched = await this.media.download(attachment.mediaId);
    if (fetched.outcome === "unavailable") {
      this.logger.warn({ event: "attachment_not_fetched", reason: fetched.reason });
      return undefined;
    }

    const key = `conversations/${conversationId}/${randomBytes(16).toString("hex")}`;

    try {
      await this.store.put(key, fetched.bytes, fetched.mediaType);
    } catch (error) {
      this.logger.error({
        event: "attachment_not_stored",
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    return {
      key,
      mediaType: fetched.mediaType,
      // Carried across so an Officer sees what the Customer called it, and
      // truncated because it is a Customer-supplied string on its way into a
      // column and then into somebody's browser.
      name: attachment.filename.slice(0, 255),
    };
  }
}
