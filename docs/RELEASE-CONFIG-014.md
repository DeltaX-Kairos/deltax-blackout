# Minimal judge deployment preparation — no deployment

MCP observer is verified with9realIPCprotocoltests. FreezeMCPsource. Newdisjointscope: src/release-config.ts, tests/release-config.test.ts, Dockerfile,.dockerignore,deployment/Caddyfile.example only. No server/service/web/core/SDK/rig/package/docs edits. Filetools only; no shell,credentials,cloud,network,Git or actualpublicexposure. Codex integrates configuration into server after verification.

Export resolvePublicOrigin(raw:string|undefined):string|null. Empty/unset->null. Nonempty mustbe exact canonical HTTPS origin only: no credentials,path(otherthan/),query,fragment,non443port,localhost/loopback/IP literal. Return canonical origin; invalid throwsfixedsanitizedconfigurationerror without echoingraw. No networkchecks or automatichostnameguess. Nodebuiltins URL/net only; input is serveroperatorenv, neverbrowser. Alsoexport deploymentCookieSecure(origin:string|null):boolean ifuseful. Allother runtimeboundaries unchanged.

Meaningful tests forvalidcustomdomain,unsetandexplicitdefault443,invalidHTTP,credentials,path/query/fragment,non443port,IP/localhost. No provider calls. Do not invent an auth or payment system.

Dockerfile: official Node22.23.2 image, npmcifrompinnedlockfile --ignore-scripts, compileapp, runtimeasnodeuser, appstillbinds127.0.0.1 bydefault. Runtimeprivateledger/credential path suppliedoperatoronly, neverimagecopy. Sourcewebassets+docs/evidence/mcpfixtureincluded. No actualcredential/ledger. Dockerusehostnetwork onlyinLinuxbehindCaddy ordescribe inCaddyfilecomment; Dockerfile itselfmustnotstartpubliclistener. .dockerignoreexcludes .git,node_modules,dist,.blackout-private,.env*,captures/video/privateartifacts,logs; root.kiro remains sourceforGit butnotneededcontainer. Preserve publicsourceallrequiredfiles.

Caddyfile.example for placeholder blackout.example.com: HTTPSautomaticTLS, basic_auth with environmentvariables BLACKOUT_JUDGE_USER and BLACKOUT_JUDGE_PASSWORD_HASH; neveractualsecrets. reverse_proxy127.0.0.1:3000; preserveHostandOriginheaders, donotrewritethem to evadeserverchecks. HSTSreasonable. Thisprotectsjudgeaccess beforeappcalls/freequota. No actualpasswordcreation, DNS,cert,portopening or server. Defaultappattemptceiling10staysunchangedinclusivehistory. JudgescanreceivecredentialsprivatelyinDevpostifpublicationisapproved.

Thesearepreparationfiles, notverifieddeployment. Reporttested/unrunaccurately; Codexrunschecks. Stopaftertheseexactfiles.
