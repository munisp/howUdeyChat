/* packs.js — sample domain packs proving the contract outside health.
 *
 * Two seed packs: agriculture extension (field reports out, advisories
 * in) and cooperative contributions (dues worklists in, payments out).
 * SEEDS — a real deployment's domain owner authors their own pack and
 * versions it; these exist to validate the engine and show the shape.
 */

export const AGRI_PACK_V1 = Object.freeze({
  domain: "agriculture",
  version: "agri-1.0.0-seed",
  inbound: {
    "extension-worklist": {
      required: ["officer", "day", "visits"],
      render: "worklist",
    },
    "advisory": {
      required: ["day", "topic", "body"],
      render: "bulletin",
    },
  },
  outbound: {
    "field-report": {
      // crop, observation, severity — a pest sighting without a crop
      // is not a report
      required: ["reporter", "day", "crop", "observation"],
    },
    "market-price": {
      required: ["reporter", "day", "commodity", "price", "market"],
    },
  },
});

export const COOP_PACK_V1 = Object.freeze({
  domain: "cooperative",
  version: "coop-1.0.0-seed",
  inbound: {
    "dues-worklist": {
      required: ["collector", "day", "due", "overdue"],
      render: "worklist",
    },
    "meeting-notice": {
      required: ["day", "meeting_day", "agenda"],
      render: "bulletin",
    },
  },
  outbound: {
    "contribution": {
      // amount and method are required; a payment claim without both
      // is refused — reconciliation runs on these lines
      required: ["member", "day", "amount", "method"],
    },
    "attendance": {
      required: ["member", "day", "meeting_day", "present"],
    },
  },
});
