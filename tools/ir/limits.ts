// The limits the parsers check a code against. The index only reads codes,
// it never sends them, so these only decide which codes are marked as too
// long.
export const IR_DEFAULT_FREQ = 38000;
export const IR_MIN_FREQ = 20000;
export const IR_MAX_FREQ = 60000;
export const IR_MAX_TIMINGS = 1024;
export const RPC_MAX_PAYLOAD = 8192;
