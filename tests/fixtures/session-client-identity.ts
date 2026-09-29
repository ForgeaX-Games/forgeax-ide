import { configureSessionClient } from "@forgeax/interface/store";
import { getSessionClient } from "@forgeax/interface/store-parts/session-client";

const client = { fixture: true };
configureSessionClient(client as never);

export const sharesSessionClientIdentity = Object.is(
	getSessionClient(),
	client,
);
