---
"@askskip/core": patch
"@askskip/server": patch
---

Fix three links in the Skip callback chain that each reported something other than what they gated. All three were recovered by hand on a live tenant.

- **The callback URL no longer defaults to loopback.** `getSkipConfig()` defaulted `baseUrl` to `http://localhost` and the SDK composed it into `callingServerURL` — the address Skip's cloud is asked to dial. Two production tenants shipped `http://localhost:4000/`, and Skip's reply ("I'm unable to reach your server ... verify the tunnel is active") sent everyone to check credentials and tunnels. A loopback callback address is now refused rather than composed: reported at boot, and refused per-request with an error naming `MJAPI_PUBLIC_URL` and stating explicitly that credentials are not the cause. An explicit `MJAPI_PUBLIC_URL` is still honoured whatever it is, loopback included, so local development against a co-located brain is unchanged — it just has to be stated rather than inherited. No callback key is minted for a request that will be refused.

- **Callback-key reprovisioning triggers on anything a fresh key could fix.** The trigger required `invalid_callback_key` *and* `retryAction === reprovision_and_retry`, making Skip's error taxonomy the gate on this side's only recovery path. The wedge that actually happened — Skip could no longer decrypt its stored callback key — arrived as `[unknown/internal_error]` and satisfied neither, so the self-heal never ran and recovery became a hand-written `UPDATE` against the tenant database. The test is now inverted: reprovision unless the failure is positively identified as something a new key cannot fix (our own outbound API key, an unreachable endpoint, a model/validation/database/component/query error). The single retry bounds the cost.

- **Delivery is no longer confirmed by the failure that falsifies it.** `confirmCallbackKeyDelivered()` ran before the `success === false` check, so a response whose entire content was "your callback credential does not work" was recorded as proof the credential had been delivered — permanently blocking `discardUnconfirmedCallbackKey()` and cementing the row, exactly as the provisioner's own docstring predicted. Confirmation is now withheld for the credential-suspect class only; a Skip-side *workflow* error still confirms, because the original reasoning holds there.

- **`resetCallbackKeyProvisioning()` reports what it did**, and `getCallbackKeyProvisioningState()` exposes the provisioner's in-memory view (never the raw key), so a reset is observable in the same process instead of being inferred from a restart.

When Skip reports that it could not reach this instance, the error now includes the callback address Skip was given — the one piece of the diagnosis only this side knows.
