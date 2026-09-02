import { OAuthConnection, transitionOAuthConnection } from "./generated/oauth-connection.machine.generated.js";
import { createApiHandler } from "./generated/api.generated.js";

const assert = {
  equal(actual, expected) {
    if (!Object.is(actual, expected)) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  },
};

const handlers = {
  guards: {
    stateMatches: (context) => context.expectedState === context.returnedState,
  },
  effects: {
    openAuthorization: (context) => ({ ...context, authorizationOpened: true }),
    saveTokens: (context) => ({ ...context, tokensSaved: true }),
    recordFailure: (context) => ({ ...context, failureRecorded: true }),
    refreshTokens: (context) => ({ ...context, tokensRefreshed: true }),
    clearTokens: (context) => ({ ...context, tokensCleared: true }),
  },
};

let session = { state: OAuthConnection.initial, context: { expectedState: "secure-state", returnedState: "secure-state" } };
session = await transitionOAuthConnection(session.state, "connect", session.context, handlers);
session = await transitionOAuthConnection(session.state, "callback", session.context, handlers);

assert.equal(session.state, "Connected");
assert.equal(session.context.authorizationOpened, true);
assert.equal(session.context.tokensSaved, true);

const api = createApiHandler({
  connectOAuth: async () => ({ status: 302, headers: { location: "https://provider.example/authorize" } }),
  completeOAuth: async ({ body }) => ({
    status: 200,
    body: { id: "00000000-0000-0000-0000-000000000001", userId: "00000000-0000-0000-0000-000000000002", provider: "example", accessToken: body.code, refreshToken: "refresh", expiresAt: new Date(0).toISOString() },
  }),
});
const redirect = await api(new Request("https://product.test/oauth/connect", { method: "POST" }));
assert.equal(redirect.status, 302);
const callback = await api(new Request("https://product.test/oauth/callback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "access", state: "secure-state" }) }));
assert.equal(callback.status, 200);
assert.equal((await callback.json()).accessToken, "access");
console.log("OAuth product flow and HTTP API completed from generated specifications");
