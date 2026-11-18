# Judge hosting plan — preparation only

No Blackout cloud resource, DNS record or production credential has been created. Account credit balances and Free-plan eligibility are not yet verified. Review this plan against the finished app before requesting deployment approval.

The measured rig requires a persistent Node22+ Linux process, local SQLite storage and owned child processes. A static page or edge-only worker cannot run that backend. Deploy one application process; the reservation ledger and rig lease must remain authoritative rather than being cloned across uncoordinated replicas.

A candidate host is one Amazon Lightsail Linux/IPv4 Small-2GB instance:2vCPUs,2GB RAM,60GB SSD, published$12/month with regional transfer conditions. Existing account credits or an eligible free offer should be checked first. The nominal bundle charge across November–January is at most$36 if active in all three months, excluding tax or usage outside the bundle; this is a planning estimate, not a verified account bill or hard platform cap. Do not create a paid plan, payment method, managed database, snapshots or additional resources under this draft.

Sources checked2026-11-17: [instance bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html), [pricing](https://aws.amazon.com/lightsail/pricing/), [billing and credits](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html).

Host through the contest judging deadline:January29,2027 at1:00PM Pacific (2027-01-29T21:00:00Z), verified in [official rules](https://kiroween.devpost.com/rules). A later cleanup needs an exact reviewed resource/backup/deletion plan and explicit authorization; stopping a VM is not assumed to end its bill. Do not create a new recurring automation without the user's request.

Use HTTPS and a dedicated subdomain of deltaxevaluate.com only after approval. Configure the server-owned public origin/Host allowlist, secure cookies, CSRF protection and bounded session/rig/attempt policies. Runtime credentials and ledgers stay outside the source tree with restrictive ownership. Worker children receive no Evaluate/AWS credentials. Live is explicitly disabled until a dedicated Blackout credential and allowance are approved, validated and installed. Preserve a zero-cost truthful recorded/replay path when live is unavailable.

Before publication: clean install test on the exact release commit; real hosted receipt retained with its request/basis; measured child-process run and cleanup verified; no secrets in source/assets/logs; support/data notice; public source/license package; uninterrupted video/captions; native canonical URL readback. Present the actual observed result, including refusals or unknowns, rather than labelling a mock as a completed hosted run.
