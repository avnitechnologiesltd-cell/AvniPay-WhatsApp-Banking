"use server";

import { redirect } from "next/navigation";

import {
  discardLibraryDraft,
  mediaTypeOf,
  publishLibraryVersion,
  uploadToLibrary,
  withdrawLibraryVersion,
} from "../../library";
import { signedIn, writing, type Landing } from "../settings/acting";

/**
 * Everything an Administrator does to the Library.
 *
 * **Four separate acts, because they are four separate decisions.** Uploading is
 * not publishing — a draft is never retrievable and the whole design rests on
 * somebody reading the extracted text in between. Withdrawing is not discarding
 * — one takes a published policy out of the Agent's reach and keeps the Bank's
 * record of it, the other throws away a draft nobody ever saw.
 *
 * None of them grants anything. Each posts to the Middleware, which checks
 * `library.write`, records the attempt and refuses a Support Officer — so the
 * worst an Officer who reaches one of these can do is leave a refusal row with
 * their name on it.
 */

const LANDING = (versionId?: string): Landing => ({
  saved: versionId ? `/library/${versionId}?saved=yes` : "/library?saved=yes",
  refused: (problem) =>
    `${versionId ? `/library/${versionId}` : "/library"}?problem=${encodeURIComponent(problem)}`,
  forbidden: "Only an Administrator may change the Library.",
});

/**
 * Uploads a document and lands on **its preview**, which is the point.
 *
 * The redirect is not navigation courtesy. An Administrator who uploaded a
 * two-column PDF has just created something that reads as interleaved nonsense,
 * and nothing in the platform can tell that from a document that read perfectly.
 * Putting them in front of the extracted text is the control.
 */
export const uploadDocument = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  const file = form.get("document");
  const title = String(form.get("title") ?? "").trim();
  const versionDate = String(form.get("versionDate") ?? "").trim();
  const documentId = String(form.get("documentId") ?? "").trim();

  if (!(file instanceof File) || file.size === 0) {
    redirect(LANDING().refused("Choose a document to upload."));
  }
  if (!title) redirect(LANDING().refused("Give the document a title."));
  if (!versionDate) {
    redirect(
      LANDING().refused(
        "Give the version date — the Bank's own date for this policy, which a citation names.",
      ),
    );
  }

  const content = Buffer.from(await file.arrayBuffer()).toString("base64");

  let versionId: string | undefined;
  await writing(
    async () => {
      const uploaded = await uploadToLibrary(session, {
        title,
        ...(documentId ? { documentId } : {}),
        versionDate,
        mediaType: mediaTypeOf(file),
        fileName: file.name,
        content,
      });
      versionId = uploaded.versionId;
    },
    {
      // Composed lazily, because where this lands is the version that did not
      // exist until the call above returned.
      get saved() {
        return `/library/${versionId}?uploaded=yes`;
      },
      refused: LANDING().refused,
      forbidden: LANDING().forbidden,
    },
  );
};

export const publishVersion = async (form: FormData): Promise<void> => {
  const session = await signedIn();
  const versionId = String(form.get("versionId") ?? "");

  await writing(() => publishLibraryVersion(session, versionId), LANDING(versionId));
};

export const withdrawVersion = async (form: FormData): Promise<void> => {
  const session = await signedIn();
  const versionId = String(form.get("versionId") ?? "");

  await writing(() => withdrawLibraryVersion(session, versionId), LANDING(versionId));
};

/**
 * Throws away a draft, and lands on the list rather than on a page that no
 * longer has anything behind it.
 */
export const discardDraft = async (form: FormData): Promise<void> => {
  const session = await signedIn();
  const versionId = String(form.get("versionId") ?? "");

  await writing(() => discardLibraryDraft(session, versionId), LANDING());
};
