// Generated from the Bitty Privacy Policy draft (sections 1–13).
import type {TermsSection} from '@/core/terms';

/** When this policy last changed. Shown at the top; change it with the text. */
export const PRIVACY_UPDATED = '2026-10-25';

/**
 * Bitty's Privacy Policy, in the same shape as the Terms (core/terms): a section per heading, its
 * paragraphs and lists in order, inline `**bold**` the only markup.
 */
export const PRIVACY: TermsSection[] = [
    {
      "title": "1. Who we are and what this covers",
      "blocks": [
        {
          "type": "p",
          "text": "This Privacy Policy explains what personal data Bitty Limited (\"Bitty\", \"we\", \"us\"), a company registered in Hong Kong, processes when you use the Bitty website at bitty.io, the Bitty mobile app and the related services (the \"Services\"), and the choices you have. It forms part of our Terms of Use."
        },
        {
          "type": "p",
          "text": "Bitty Limited is the data controller. Our registered office is Unit 507, 5/F, New East Ocean Centre, No. 9 Science Museum Road, Tsim Sha Tsui East, Hong Kong, and you can reach us at info@bitty.io."
        },
        {
          "type": "p",
          "text": "Bitty is non-custodial: your vault is a smart contract you own, and the keys that control it never leave your device. That shapes everything below — we hold very little about you, and most of what the Services show is read from public blockchains."
        }
      ]
    },
    {
      "title": "2. What we never collect",
      "blocks": [
        {
          "type": "p",
          "text": "We never receive, store or have access to:"
        },
        {
          "type": "ul",
          "items": [
            "your recovery phrase or private keys;",
            "your device passcode, Face ID or other biometric data (the device checks them; we only learn that a signature was made);",
            "your name, email, phone number or identity documents, unless you choose to email us;",
            "your payment card or bank details — the Services take no fiat payments."
          ]
        },
        {
          "type": "p",
          "text": "We will never ask for your recovery phrase or private key. Anyone who does is not us."
        }
      ]
    },
    {
      "title": "3. What stays on your device",
      "blocks": [
        {
          "type": "p",
          "text": "The mobile app keeps these on your device only, and never sends them to us:"
        },
        {
          "type": "ul",
          "items": [
            "your recovery phrase and keys, in the device's secure storage behind its biometrics;",
            "names you give your vaults and whitelisted addresses;",
            "tokens you add by contract address, your watch lists, and display settings such as language, currency and theme;",
            "a custom blockchain node (RPC) you set, if any."
          ]
        },
        {
          "type": "p",
          "text": "They are lost if you delete the app or lose the device, except what the recovery phrase restores (your keys and vaults). On the website, similar preferences are kept in your browser's local storage."
        }
      ]
    },
    {
      "title": "4. What we process, and why",
      "blocks": [
        {
          "type": "p",
          "text": "What we process is mostly wallet and vault addresses, which are pseudonymous but can be personal data once linked to you. The legal basis given is the one that applies where the GDPR does."
        },
        {
          "type": "ul",
          "items": [
            "**Wallet and vault addresses** — whenever the apps load your vault, to show balances, history, positions and pending changes. Basis: contract.",
            "**Signed instructions you send through the relayer** (vault, signing address, the actions, status and transaction hash) — when the vault pays a network fee for you, to submit them to the blockchain, charge the fee and show the result in your history. Basis: contract.",
            "**Your fee-payment preference**, by wallet address — when you change it, to pay network fees the way you chose. Basis: contract.",
            "**Recent trade searches**, by wallet address — when you search for an asset, to show your recent searches. Basis: legitimate interest.",
            "**IP address, device and browser type, request logs** — on every request to our servers, to run, secure and debug the Services and prevent abuse. Basis: legitimate interest.",
            "**Error reports, and on the website, recordings of some sessions with text and inputs masked** — when something goes wrong, and for a sample of website visits, to find and fix faults. Basis: legitimate interest.",
            "**Website analytics** (pages visited, device, approximate location) — on the website, to understand how it is used. Basis: consent where required.",
            "**Emails you send us** — when you contact info@bitty.io, to answer you. Basis: legitimate interest."
          ]
        },
        {
          "type": "p",
          "text": "The mobile app contains no analytics or crash-reporting SDK. We do not sell personal data, use it for advertising, or make decisions about you by automated means that have legal or similar effects."
        }
      ]
    },
    {
      "title": "5. Blockchain data is public",
      "blocks": [
        {
          "type": "p",
          "text": "Everything your vault does on chain — its address, balances, transfers, trades, settings, whitelisted addresses and owner — is recorded on public blockchains that anyone can read, permanently."
        },
        {
          "type": "p",
          "text": "We index that public data to make the Services fast, but we do not control it, and we cannot change or delete it. A request to delete your data (section 11) covers what we hold on our servers, not the blockchain itself. Linking your identity to an address, for example by sharing it, can make your on-chain activity identifiable."
        }
      ]
    },
    {
      "title": "6. Third parties and service providers",
      "blocks": [
        {
          "type": "p",
          "text": "We use a small number of providers to run the Services; each sees only what its job needs."
        },
        {
          "type": "ul",
          "items": [
            "**Hosting and database providers** receive requests, logs and the data in section 4, to run our servers.",
            "**Error monitoring providers** receive error reports and device and browser details, and on the website, masked recordings of some sessions, to find and fix faults.",
            "**Website analytics (Google Analytics)** receives pages visited, device, approximate location and cookie identifiers, to understand website use.",
            "**Blockchain node providers** receive your IP address and the addresses and data your app reads or sends: the app reads the chain and submits transactions through them. You can set your own node instead.",
            "**Market trading and limit-order protocols** receive your vault address and order details, as on chain, to quote and settle your trades.",
            "**App stores (Apple App Store)** receive what their own policies describe, to deliver the mobile app."
          ]
        },
        {
          "type": "p",
          "text": "The protocols your vault uses through its adapters (section 8 of the Terms) process your transactions under their own privacy terms. We are not responsible for their practices."
        }
      ]
    },
    {
      "title": "7. Sharing and disclosure",
      "blocks": [
        {
          "type": "p",
          "text": "We do not sell or rent personal data. We share it only:"
        },
        {
          "type": "ul",
          "items": [
            "with the providers in section 6, under contracts that limit their use to serving us;",
            "with our affiliates, for the same purposes as this policy;",
            "with a buyer or successor if Bitty is merged, acquired or reorganised, under this policy's protections;",
            "when the law, a court or a regulator requires it, or to protect the Services, our users or the public from fraud, attack or harm;",
            "with your consent."
          ]
        }
      ]
    },
    {
      "title": "8. Retention",
      "blocks": [
        {
          "type": "p",
          "text": "We keep personal data only as long as the purpose needs, then delete or anonymise it."
        },
        {
          "type": "ul",
          "items": [
            "**Indexed on-chain data for your vault:** while the Services support the vault; it stays public on chain regardless.",
            "**Relay attempts:** 24 months, for your history and to resolve disputes about fees.",
            "**Fee-payment preference and recent trade searches:** until you change or clear them, or 12 months without use.",
            "**Server logs:** 90 days.",
            "**Error reports and session recordings:** 90 days.",
            "**Website analytics:** at most 14 months.",
            "**Emails to us:** as long as needed to answer you, then 24 months."
          ]
        },
        {
          "type": "p",
          "text": "We may keep data longer where the law requires it or to establish or defend legal claims."
        }
      ]
    },
    {
      "title": "9. Security",
      "blocks": [
        {
          "type": "p",
          "text": "The strongest protection is what we do not hold: your keys never reach us, so a breach of our servers cannot move your assets. For what we do hold, we use encryption in transit, access controls and the security measures of our providers."
        },
        {
          "type": "p",
          "text": "No system is perfectly secure. If a breach affects your personal data, we will notify you and the authorities where the law requires. Keeping your device and recovery phrase safe is up to you (section 5 of the Terms)."
        }
      ]
    },
    {
      "title": "10. International transfers",
      "blocks": [
        {
          "type": "p",
          "text": "We are based in Hong Kong, and our providers process data in other countries, including the United States. Where the law of your country requires it, we protect transfers with the safeguards it recognises, such as the European Commission's Standard Contractual Clauses. Ask us at info@bitty.io for details."
        }
      ]
    },
    {
      "title": "11. Your rights and choices",
      "blocks": [
        {
          "type": "p",
          "text": "Depending on where you live, you may ask us to give you a copy of, correct, delete or restrict the personal data we hold about you, object to our processing, receive it in a portable form, or withdraw consent. Email info@bitty.io from any address and tell us which wallet or vault addresses the request concerns; we may ask you to sign a message with that address to prove it is yours. We reply within the time the law sets, usually 30 days, at no charge."
        },
        {
          "type": "ul",
          "items": [
            "**Hong Kong.** You have the rights of access and correction under the Personal Data (Privacy) Ordinance.",
            "**EEA, United Kingdom and Switzerland.** You have the GDPR rights above, and may complain to your data protection authority.",
            "**California and other US states.** You may know, delete and correct your data. We do not sell or share personal data for cross-context behavioural advertising, and we will not treat you differently for using these rights."
          ]
        },
        {
          "type": "p",
          "text": "You can also act yourself: clear the app's data or uninstall it to remove what is on your device; block or opt out of analytics cookies in your browser; set your own blockchain node in the app. We cannot delete public blockchain data (section 5)."
        }
      ]
    },
    {
      "title": "12. Children",
      "blocks": [
        {
          "type": "p",
          "text": "The Services are not for anyone under 18 or the age of majority where they live, and we do not knowingly collect data from them. If you believe a child has used the Services, contact info@bitty.io and we will delete what we hold."
        }
      ]
    },
    {
      "title": "13. Changes and contact",
      "blocks": [
        {
          "type": "p",
          "text": "We may update this policy; the date at the top changes when we do, and we give notice in the apps or on the website before a material change takes effect. The website does not respond to browser Do Not Track signals."
        },
        {
          "type": "p",
          "text": "Questions, requests and complaints: info@bitty.io, or Bitty Limited, Unit 507, 5/F, New East Ocean Centre, No. 9 Science Museum Road, Tsim Sha Tsui East, Hong Kong."
        }
      ]
    }
  ];
