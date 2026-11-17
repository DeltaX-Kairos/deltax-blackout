"use strict";
globalThis.fetch = async function blockedLiveFetch() { throw new Error("Unexpected live fetch blocked by Blackout offline tests"); };
