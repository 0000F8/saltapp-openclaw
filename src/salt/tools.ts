// Two Salt-specific agent tools, following the pattern bundled channel
// plugins use for a platform action beyond the shared `message` tool (see
// WhatsApp's `whatsapp_call` in extensions/whatsapp/src/agent-tools-call.ts
// in github.com/openclaw/openclaw: `api.registerTool((context) => tool |
// null, {name})`, gated on `context.messageChannel` so the tool only shows
// up on a Salt turn).
//
// `salt_post_card` posts an interactive Blocks card (CARD_PROTOCOL_SPEC.md)
// -- choices, not free text, per skills/salt-etiquette/SKILL.md.
// `salt_request_payment` creates a plain (non-invoice) TransferRequest in
// the current chat. Neither tool ever claims money was SENT -- Salt has no
// agent-callable "send" tool at all yet (see CLAUDE.md's "Money is
// evidence": no agent tool can send money, only report on a transfer that
// already settled).
//
// SDK-INTEGRATION-GUESS: `AnyAgentTool`/`OpenClawPluginToolContext` are this
// plugin's own stand-in types (src/types/openclaw-plugin-sdk.d.ts), not the
// real compiled SDK's. See HANDOFF.md.

import type { CardBlock } from "salt-agent-sdk";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createPaymentRequest, type SaltRestOptions } from "./rest.js";

export interface SaltToolDeps {
  /** Resolves the current chat id this OpenClaw turn is replying in.
   *  Exact accessor is unverified against the real SDK -- see
   *  HANDOFF.md's open questions -- so it's injected rather than read
   *  directly from `context` inside this module. */
  resolveCurrentChatId: (context: OpenClawPluginToolContext) => string | undefined;
  postCard: (chatId: string, blocks: CardBlock[], text: string) => Promise<unknown>;
  updateCard: (cardId: string, blocks: CardBlock[]) => Promise<unknown>;
  restOptions: SaltRestOptions;
}

const SaltCardBlockSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["section", "divider", "image", "actions", "fields"] },
    text: { type: "string" },
    image_url: { type: "string" },
    fields: { type: "array", items: { type: "string" } },
    buttons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          action_id: { type: "string" },
          action_type: { type: "string", enum: ["default", "pay"] },
        },
        required: ["label", "action_id"],
      },
    },
  },
  required: ["kind"],
} as const;

export function createSaltPostCardTool(deps: SaltToolDeps): (context: OpenClawPluginToolContext) => AnyAgentTool | null {
  return (context) => {
    if (context.messageChannel !== "salt") return null;
    const chatId = deps.resolveCurrentChatId(context);
    if (!chatId) return null;

    return {
      name: "salt_post_card",
      label: "Post a Salt card",
      description:
        "Post an interactive Blocks card into the current Salt chat -- a section/fields/image/divider/actions layout with tappable buttons. " +
        "Use this for choices and structured summaries instead of a wall of text; never use a 'pay' button to claim money was sent -- Salt " +
        "creates the real payment request when the button is tapped, and the agent only finds out later, via salt_request_payment's own " +
        "confirmation or a payment webhook.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          blocks: { type: "array", items: SaltCardBlockSchema },
          text: { type: "string", description: "Fallback text shown alongside the card." },
          update_card_id: {
            type: "string",
            description: "If set, update this existing card instead of posting a new one.",
          },
        },
        required: ["blocks"],
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { blocks: CardBlock[]; text?: string; update_card_id?: string };
        if (params.update_card_id) {
          return deps.updateCard(params.update_card_id, params.blocks);
        }
        return deps.postCard(chatId, params.blocks, params.text ?? "");
      },
    };
  };
}

export function createSaltRequestPaymentTool(
  deps: SaltToolDeps,
): (context: OpenClawPluginToolContext) => AnyAgentTool | null {
  return (context) => {
    if (context.messageChannel !== "salt") return null;
    const chatId = deps.resolveCurrentChatId(context);
    if (!chatId) return null;

    return {
      name: "salt_request_payment",
      label: "Request a payment on Salt",
      description:
        "Create a payment request in the current Salt chat, asking a specific member to pay this agent's own wallet. This only creates " +
        "the request bubble -- it does NOT move money. Never tell the person money was sent or received because this tool ran; only a " +
        "confirmed on-chain transfer means the request was paid, and this tool has no way to observe that.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          payer_id: { type: "string", description: "The Salt user id of the chat member being asked to pay." },
          wallet_id: { type: "string", description: "This agent's own Salt wallet id that should receive the payment." },
          amount: { type: "string", description: "Human-decimal amount, e.g. \"12.50\"." },
          message: { type: "string", description: "Short note shown on the request bubble." },
        },
        required: ["payer_id", "wallet_id", "amount"],
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { payer_id: string; wallet_id: string; amount: string; message?: string };
        return createPaymentRequest(deps.restOptions, {
          chatId,
          payerId: params.payer_id,
          walletId: params.wallet_id,
          amount: params.amount,
          message: params.message,
        });
      },
    };
  };
}
