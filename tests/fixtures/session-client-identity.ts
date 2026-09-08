import { configureSessionClient } from '@forgeax/interface/store';
// @ts-expect-error The fixture deliberately imports the source-only runtime alias.
import { getSessionClient } from '@forgeax/interface/store-parts/session-client';

const client = { fixture: true };
configureSessionClient(client as never);

export const sharesSessionClientIdentity = getSessionClient() === client;
