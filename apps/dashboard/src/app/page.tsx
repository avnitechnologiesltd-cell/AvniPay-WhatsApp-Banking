import { redirect } from "next/navigation";

import { currentSession } from "../session";

/**
 * There is no home screen, and there should not be one.
 *
 * The Dashboard's surfaces are Inbox, **Customers**, Settings and Snippet, and a
 * landing page listing them would be a page nobody reads twice. Customers is
 * where an Officer starts, because somebody is on the telephone.
 *
 * The Inbox, Settings and Snippet screens arrive with their own slices; their
 * endpoints are built and driven by `tests/inbox.test.ts` and
 * `tests/in-app-chat.test.ts` already.
 */
const Home = async (): Promise<never> => {
  redirect((await currentSession()) ? "/customers" : "/sign-in");
};

export default Home;
