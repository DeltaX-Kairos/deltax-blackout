# Blackout publication review

## Finished private deliverables

- Working local application, real hosted Evaluate path and separate measured worker rig.
- 290 passing automated tests; no hosted traffic from the test suite.
- Two fresh hosted reviews in an uninterrupted 147.14-second browser take; final 1080p/24fps video with natural library narration, no time stretching or pitch shifts, and captions.
- Sanitized evidence, judge instructions, architecture, source attribution and Devpost draft.
- Private Git checkpoint and draft PR. The exact commit and media hashes are recorded in the accompanying private release manifest after checkpointing.

Runtime source is frozen at SHA-256 `5feac6d52e00356fddfef3da64721ff465778340a8af49649138a3fc7b15c4d0`. Documentation/media do not change that runtime. The captured app matches this digest; the sole post-capture source tidy removes trailing HTML whitespace, with both file digests preserved privately. No markup, script, style or behavior changed. No credentials or private ownership identifiers occur in the sanitized evidence.

## Approval requested for the public release

1. Make the fresh `DeltaX-Kairos/deltax-blackout` repository public under its existing MIT application license, including `.kiro`, tests and sanitized proof. Proprietary Evaluate engine source and ignored private artifacts remain excluded.
2. Publish the finished **Blackout — Kiroween 2026 | When a Recovery Decision Expires** video on DeltaX Evaluate's YouTube channel, with its prepared description and captions. Its upload requires the native action-time Terms confirmation.
3. Provision one dedicated Blackout judging host using the proposed Lightsail 2GB IPv4 Linux bundle at its published $12/month rate, through January 29, 2027, 1 PM Pacific. November–January nominal bundle charges are at most $36, excluding taxes or out-of-bundle usage; AWS does not provide a hard total bill cap through this application. Inspect existing credits first. No paid-plan upgrade, payment-method setup, snapshots or extra services are included.
4. Create the single `blackout.deltaxevaluate.com` DNS record and HTTPS route for that host, protected with a dedicated judge password. Save the password privately and provide it only in the contest judge-access field. No existing service/DNS record is to be replaced.
5. Install the dedicated Blackout Evaluate credential on that named server in a private service environment. It was previously approved only for the local server; transferring it to this host requires expanded destination authorization. Worker processes must receive no secret.

The current development ledger remains ten attempts inclusive of history, with four completed and six remaining. This is enough for one clean hosted deployment rehearsal and two full judge sessions. **This review requests no allowance reset, increase, new credential or paid Evaluate plan.** If more judge capacity is wanted, an exact additional allowance can be approved separately. Maintain two attempts per persistent browser identity, one globally active request and no automatic retry.

## Release checks after approval

Deploy the exact private checkpoint, preserve the existing reservation history, verify HTTPS/origin/cookie behavior and authenticate from a clean browser. Run one bounded hosted rehearsal and a measured rig/cleanup check. Verify the canonical live URL, public Git and video independently, then fill their actual links in the Devpost draft. A local test or provisioning success is not a public deployment readback.

Kiroween registration/eligibility attestation, its binding Terms and final Devpost submission are not included in this approval request. Prepare those exact screens after the public release is verified. No new recurring automation is requested. Resource cleanup will require an exact reviewed retention/deletion plan rather than an implicit irreversible deletion.

## Known limits

The app is a recovery rehearsal, not a production remediation agent. Scripted proposal values are disclosed. The process rig runs fixed trusted code under the same OS user, not an adversarial-code sandbox. Hashes are application integrity bindings, not independent attestation. Docker is prepared but not locally built; direct Node operation is verified. AWS credit balance is currently unknown. There is no customer study or production-impact claim.
