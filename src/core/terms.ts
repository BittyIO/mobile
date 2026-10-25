// Generated from the Bitty Terms of Use draft (sections 1–18).
export type TermsBlock = {type: 'p'; text: string} | {type: 'ul' | 'ol'; items: string[]};
export type TermsSection = {title: string; blocks: TermsBlock[]};

/** When these Terms last changed. Shown at the top; change it with the text. */
export const TERMS_UPDATED = '2026-10-25';

/**
 * Bitty's Terms of Use, as structured text: a section per heading, its paragraphs and lists in
 * order. Inline `**bold**` is the only markup. The same text ships in the web and mobile apps; edit
 * both together.
 */
export const TERMS: TermsSection[] = [
  {
    "title": "1. Agreement to these Terms",
    "blocks": [
      {
        "type": "p",
        "text": "These Terms of Use (\"Terms\") are a legally binding agreement between you and Bitty Limited (\"Bitty\", \"we\", \"us\"). They govern your use of the Bitty website at bitty.io, the Bitty mobile app, and the software and services described in section 2 (together, the \"Services\")."
      },
      {
        "type": "p",
        "text": "By creating or importing a wallet, activating or using a vault, or otherwise using the Services, you accept these Terms and our Privacy Policy. If you do not agree, do not use the Services."
      },
      {
        "type": "p",
        "text": "Section 16 requires most disputes to be resolved by binding individual arbitration and waives class actions. Please read it."
      },
      {
        "type": "p",
        "text": "If you use the Services for an organisation, a DAO or a multi-signature wallet whose other owners are not you, you confirm you are authorised to accept these Terms for it, and \"you\" includes it."
      }
    ]
  },
  {
    "title": "2. The Services",
    "blocks": [
      {
        "type": "p",
        "text": "Bitty is software for holding, sending, trading and earning with digital assets through a smart-contract vault that you own."
      },
      {
        "type": "ul",
        "items": [
          "**The Bitty Vault.** A smart contract on a public blockchain, deployed for and owned by your address (or a multi-signature wallet you name). Only its owner, and an asset manager the owner appoints, can instruct it. A vault is created by its first transaction; until then its address is reserved for you but nothing is deployed.",
          "**The apps.** The Bitty mobile app and website, which create or import your keys on your device, show your vault, and let you prepare and sign instructions to it.",
          "**The relayer.** An optional service that submits your signed instructions to the blockchain and pays the network fee, which your vault then repays (section 7).",
          "**Supporting services.** Price, balance, history and ownership data we index and serve to the apps, the address book and version information. These are conveniences; the blockchain is the record.",
          "**Third-party services.** exchanges, order networks, yield and staking protocols, price oracles and wallets that the apps connect your vault to (section 8). We do not operate them."
        ]
      },
      {
        "type": "p",
        "text": "The Services are available on the networks the apps list, which may change. A vault exists only on the networks where it has been deployed."
      },
      {
        "type": "p",
        "text": "We may change, suspend or discontinue any part of the Services at any time (section 10). Support is available at info@bitty.io and is informational only: we will never ask for your recovery phrase or private key, and we do not give support through SMS, WhatsApp, Telegram or other direct messages. Anyone who does is not us."
      }
    ]
  },
  {
    "title": "3. Non-custodial software, not a broker or adviser",
    "blocks": [
      {
        "type": "p",
        "text": "Bitty is a developer of software. We never hold your digital assets, your private keys or your recovery phrase, and we cannot move, freeze, recover or reverse anything in your vault."
      },
      {
        "type": "ul",
        "items": [
          "Your assets sit in your vault, a contract you own. Every transaction is an instruction your key signs; the vault carries it out under its own code.",
          "The relayer only submits instructions you have signed. It cannot alter them, and your vault rejects anything not signed by its owner or an asset manager it appointed.",
          "We are not a broker, dealer, exchange, custodian, money transmitter, bank or investment adviser. We do not hold, match or route orders on your behalf, and transactions settle directly between your vault and the smart contracts you choose.",
          "We are not registered or licensed with any financial regulator. Nothing in the Services is investment, legal, tax or financial advice, including yields, prices, quotes and security levels shown in the apps.",
          "These Terms create no fiduciary or agency relationship. We owe you no duties beyond those these Terms expressly state."
        ]
      }
    ]
  },
  {
    "title": "4. Eligibility, sanctions and prohibited use",
    "blocks": [
      {
        "type": "p",
        "text": "You may use the Services only if all of these are true:"
      },
      {
        "type": "ul",
        "items": [
          "You are at least the age of majority where you live and can form a binding contract.",
          "You are not a person or entity on any sanctions list of the United Nations, United States (including OFAC's SDN list), European Union, United Kingdom or any other applicable authority, nor owned or controlled by one.",
          "You are not located in, or a national or resident of, Cuba, Iran, North Korea, Sudan or Syria, or any other country or region subject to comprehensive sanctions of the United Nations, United States, European Union or United Kingdom.",
          "Using the Services is not unlawful for you where you are."
        ]
      },
      {
        "type": "p",
        "text": "You agree not to use the Services to:"
      },
      {
        "type": "ul",
        "items": [
          "break any law, including sanctions, anti-money-laundering and counter-terrorist-financing laws;",
          "move assets that are not lawfully yours or that come from crime, fraud or theft;",
          "defraud, impersonate or harass anyone, or deploy fake or misleading tokens;",
          "attack, overload, scrape or reverse engineer the Services, or reach them through automated means other than the apps (beyond what open-source licences allow);",
          "get around geographic or other restrictions, for example with a VPN."
        ]
      },
      {
        "type": "p",
        "text": "We may block addresses, vaults or regions from the apps, the relayer and our data services to comply with law or protect the Services. We cannot block a vault on chain."
      }
    ]
  },
  {
    "title": "5. Your keys, recovery phrase and security",
    "blocks": [
      {
        "type": "p",
        "text": "You alone control your vault, so you alone are responsible for the keys that control it."
      },
      {
        "type": "ul",
        "items": [
          "**Recovery phrase.** The apps create or import a 12- or 24-word recovery phrase on your device. It is the only backup of your keys and every vault they own. Anyone who learns it can take everything in those vaults. If you lose it and your device, no one, including us, can restore access.",
          "**We never see it.** The phrase and keys stay on your device, protected by its secure storage and biometrics. We do not store, transmit or recover them.",
          "**Keep it offline.** Write it down and store it safely. Keeping it in a photo, a note, email or cloud storage greatly increases the risk of theft.",
          "**Several owners from one phrase.** Each additional vault you create uses another key derived from the same phrase. The phrase restores them all; names you give vaults and address-book entries are kept only on your device.",
          "**Your device.** You are responsible for its security, its operating system and app updates, and for everything done with your keys, including by malware, phishing or someone who obtains them.",
          "**Multi-signature wallets.** If your vault is owned by a multi-signature wallet, that wallet's owners and threshold decide what it signs. You are responsible for its configuration and its other owners."
        ]
      },
      {
        "type": "p",
        "text": "We will never ask for your recovery phrase or private key. If you suspect your key is compromised, lock your vault (section 6) and move your assets to a new owner."
      }
    ]
  },
  {
    "title": "6. Vault controls",
    "blocks": [
      {
        "type": "p",
        "text": "Your vault enforces its own safety rules on chain. They protect you only as you configure them, and they bind you as much as anyone who takes your key."
      },
      {
        "type": "ul",
        "items": [
          "**Timelock.** 1 to 30 days that any loosening must wait out: higher limits, a new whitelisted address, a new asset manager, a new owner. You may have to wait to reach your own money in a new way; tightening applies at once.",
          "**Send to new in 24 hours.** The most stablecoin value plain sends may move in a rolling 24 hours, $0 to $10,000; $0 turns them off. Anything above it, or any other asset, can only go to a whitelisted address.",
          "**Market trade slippage in 24 hours.** The most market trades may lose against oracle prices in a rolling 24 hours, $0 to $10,000; $0 turns market trading off. Each trade must also come within 5% of oracle value, and only assets with a price feed can be traded at market.",
          "**Whitelisted addresses.** Addresses the vault may pay without those limits, once their timelock has passed. Payments to them are not capped; choose them carefully.",
          "**Temporary lock.** Freezes the vault's settings at once; money can then go only to existing whitelisted addresses; reversible by the owner. Pending changes are cancelled.",
          "**Forever lock.** The same freeze, permanently, for anyone, ever. It cannot be undone by you, us or anyone; money can only ever leave to whitelisted addresses.",
          "**Asset manager.** An address you appoint, with the permissions and expiry you set (up to 365 days), to trade and earn but not to send. You are responsible for whom you appoint and what they do within those permissions.",
          "**Ownership transfer.** Hands the vault to a new owner once the timelock has passed, with no step for the receiver. The transfer is final once it lands; check the address."
        ]
      },
      {
        "type": "p",
        "text": "Defaults, presets (\"High\", \"Mid\", \"Low\") and recommendations in the apps are suggestions, not advice. Some controls need a minimum vault version (for example, $0 allowances need version 1.0.5 or later). We cannot override, waive or undo any of them for you."
      }
    ]
  },
  {
    "title": "7. Network fees, the relayer and Bitty fees",
    "blocks": [
      {
        "type": "p",
        "text": "Every transaction costs a blockchain network fee (gas), paid either by your vault through the relayer or by your own wallet."
      },
      {
        "type": "ul",
        "items": [
          "**Paid by your vault.** When you choose to have your vault pay, you sign the instruction and the relayer submits it and pays the gas. Your vault then repays the relayer in a token you allow (such as a stablecoin or wrapped ether), at the network fee actually used plus a margin of 15%, within the per-operation and daily fee limits you set on the vault.",
          "**Estimates only.** Fees, quotes, prices and amounts shown before you sign are estimates. The final fee depends on the network at the time and may be higher.",
          "**Paid by you.** You may pay gas from your own wallet instead. That transaction is between you and the network.",
          "**No guarantee of service.** The relayer may decline, delay or stop serving any transaction, network or vault, for example if your vault cannot pay or its fee limit is reached. It never sends from your wallet without your choice.",
          "**Bitty fees.** We charge 0.2% of each market trade, limit order and TWAP order, taken in the trade and shown before you sign. We charge nothing else beyond the network fee repayment above. We may change our fees with notice in the apps; a change never applies to a transaction you already signed.",
          "**Third-party fees.** Exchanges, order networks and protocols charge their own fees. We are not responsible for them.",
          "**Taxes.** You are responsible for any taxes on your use of the Services."
        ]
      }
    ]
  },
  {
    "title": "8. Third-party protocols and services",
    "blocks": [
      {
        "type": "p",
        "text": "The apps connect your vault to services that other people build and run; you use them at your own election and risk."
      },
      {
        "type": "p",
        "text": "These include, by category: market trading protocols (exchanges and swap routers), limit-order and intent protocols, yield, lending and staking protocols, price oracles, multi-signature wallets, and the blockchain networks themselves. Your vault reaches each protocol through an adapter registered for its category."
      },
      {
        "type": "ul",
        "items": [
          "We do not control, audit or guarantee them, and listing one in the apps is not an endorsement.",
          "Their terms, fees and privacy policies apply to you as well as ours.",
          "They can change, pause, fail or be exploited. A limit or TWAP order may never fill, a yield may change or vanish, and an asset deposited with them is subject to their risks.",
          "Your vault's allow list decides which assets and services it may use. Turning on Bitty's allow list limits it to those Bitty has registered; that registration is not a guarantee of safety.",
          "We are not liable for any loss caused by a third-party service, including one reached through the apps."
        ]
      }
    ]
  },
  {
    "title": "9. Risks you accept",
    "blocks": [
      {
        "type": "p",
        "text": "Using blockchains and digital assets can lose you everything you put in; you accept these risks, among others."
      },
      {
        "type": "ul",
        "items": [
          "**Smart contracts.** Your vault and every protocol it uses are code that may contain bugs or be exploited, audited or not.",
          "**Irreversibility.** Transactions are final. There are no refunds, chargebacks or recoveries, including for a wrong address or amount.",
          "**Volatility.** Digital asset prices can fall sharply. Stablecoins can lose their peg.",
          "**Fake tokens.** Anyone can create a token, including copies of real ones. Check any token you add by contract address.",
          "**Network fees.** Gas can rise sharply and suddenly, and a transaction can fail and still cost a fee.",
          "**Oracles and prices.** Price feeds can be wrong, stale or manipulated; trades and limits that rely on them inherit that.",
          "**Timelocks work both ways.** The delays that protect you also delay you, including from your own funds.",
          "**Networks.** A blockchain can halt, fork, congest or change its rules. An L2 can stop its sequencer.",
          "**Regulation.** Laws may change and may restrict or end the Services or particular assets where you are.",
          "**Cryptography.** Advances in computing, including quantum computing, could break today's signatures. We may update the vault for this but make no binding promise to."
        ]
      },
      {
        "type": "p",
        "text": "You are solely responsible for evaluating any transaction, contract and token before you use it."
      }
    ]
  },
  {
    "title": "10. Vault upgrades, app versions and availability",
    "blocks": [
      {
        "type": "p",
        "text": "Your vault changes only when you choose to upgrade it, and the apps may stop supporting old versions."
      },
      {
        "type": "ul",
        "items": [
          "**Upgrades are yours to make.** New vault versions are published to Bitty's on-chain registry. Your vault moves to one only when you sign the upgrade. An upgrade cannot be undone, and a newer version may behave differently.",
          "**App versions.** A vault version may need a newer app. The apps may refuse to act on a vault they cannot run correctly, and ask you to update.",
          "**No promise of availability.** The apps, the relayer and our data services may be slow, wrong or unavailable, and we may change or end any of them. Your vault stays on chain regardless and can be used with other tools that support it.",
          "**Your own data sources.** You may point the app at your own blockchain node; we are not responsible for what it returns."
        ]
      }
    ]
  },
  {
    "title": "11. Intellectual property and open source",
    "blocks": [
      {
        "type": "p",
        "text": "The Services, the Bitty name and logo, and the apps' design belong to Bitty Limited or its licensors. We give you a limited, personal, non-exclusive, non-transferable, revocable licence to use the apps to access the Services under these Terms."
      },
      {
        "type": "p",
        "text": "Some code, including the vault contracts, is published under open-source licences. Where an open-source licence applies, its terms govern that code and prevail over this section."
      },
      {
        "type": "p",
        "text": "You may not copy, modify, resell or create derivative works of the apps (beyond what those licences allow), use our marks without permission, or remove notices. If you send us feedback, we may use it freely without obligation to you."
      }
    ]
  },
  {
    "title": "12. Disclaimers",
    "blocks": [
      {
        "type": "p",
        "text": "THE SERVICES ARE PROVIDED \"AS IS\" AND \"AS AVAILABLE\", WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT."
      },
      {
        "type": "p",
        "text": "We do not warrant that the Services, the vault contracts or any third-party service will be uninterrupted, secure, error-free or free of harmful code, or that any price, balance, yield, fee estimate or other information shown is accurate or current. You have not relied on any statement not set out in these Terms."
      },
      {
        "type": "p",
        "text": "Some jurisdictions do not allow some of these exclusions; there, they apply to the fullest extent permitted."
      }
    ]
  },
  {
    "title": "13. Limitation of liability and release",
    "blocks": [
      {
        "type": "p",
        "text": "TO THE FULLEST EXTENT PERMITTED BY LAW, BITTY LIMITED, ITS AFFILIATES, AND THEIR DIRECTORS, EMPLOYEES, CONTRACTORS AND AGENTS (\"BITTY PARTIES\") ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DIGITAL ASSETS, LOST DATA OR LOSS OF GOODWILL, ARISING FROM THE SERVICES, WHETHER IN CONTRACT, TORT OR OTHERWISE, EVEN IF ADVISED OF THEIR POSSIBILITY."
      },
      {
        "type": "p",
        "text": "THE BITTY PARTIES' TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICES IS LIMITED TO THE LOWER OF (A) THE BITTY FEES YOU PAID IN THE 12 MONTHS BEFORE THE CLAIM AROSE AND (B) ONE HUNDRED U.S. DOLLARS (US$100)."
      },
      {
        "type": "p",
        "text": "Without limiting the above, the Bitty Parties are not liable for: loss of your recovery phrase or keys; transactions you or anyone with your keys signed; the operation of your vault's controls as configured; third-party services; network fees or failed transactions; or anything outside our reasonable control."
      },
      {
        "type": "p",
        "text": "You release the Bitty Parties from claims arising from those matters. If you are a California resident, you waive California Civil Code §1542, which says: \"A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party.\""
      },
      {
        "type": "p",
        "text": "Nothing in these Terms limits liability that cannot be limited by law, such as for fraud or for death or personal injury caused by negligence."
      }
    ]
  },
  {
    "title": "14. Indemnity",
    "blocks": [
      {
        "type": "p",
        "text": "You will defend, indemnify and hold harmless the Bitty Parties from any claim, loss, liability, cost or expense (including reasonable legal fees) arising from: your use of the Services; your vault and the transactions signed with your keys; your use of any third-party service; your breach of these Terms; or your violation of any law or anyone else's rights."
      }
    ]
  },
  {
    "title": "15. Suspension and termination",
    "blocks": [
      {
        "type": "p",
        "text": "We may suspend or end your access to the apps, the relayer or our data services at any time, without notice or liability, including if we believe you breached these Terms, used the Services unlawfully, or put the Services or others at risk."
      },
      {
        "type": "p",
        "text": "Suspension never touches your vault: it stays on chain, under your keys, with its controls as you set them, and you can use it through other compatible tools or by paying network fees from your own wallet."
      },
      {
        "type": "p",
        "text": "You may stop using the Services at any time. Sections 3, 5, 9, 11 to 14, 16 and 18 survive termination."
      }
    ]
  },
  {
    "title": "16. Governing law and disputes",
    "blocks": [
      {
        "type": "p",
        "text": "Disputes go to binding individual arbitration after a 30-day attempt to resolve them informally: under Texas law and JAMS rules if you live in the United States, and under Hong Kong law at the Hong Kong International Arbitration Centre (HKIAC) everywhere else."
      },
      {
        "type": "ol",
        "items": [
          "**Notice first.** Before any claim, send a written notice of dispute to info@bitty.io describing the claim and the relief you want. We will do the same to the contact details we have for you. Each side has 30 days to try to resolve it. A claim brought without this step may be dismissed.",
          "**Your country of residence** is where you are a citizen or permanent resident, or the country from which you regularly use the Services.",
          "**If you live in the United States.** These Terms are governed by the laws of the State of Texas, and the Federal Arbitration Act governs this section. Disputes are resolved by binding arbitration administered by JAMS under its Comprehensive Arbitration Rules and Procedures (expedited procedures where available), before one arbitrator. Any court proceeding allowed by this section is brought only in the federal or state courts located in Tarrant County, Texas. You and we waive any right to a jury trial.",
          "**If you live anywhere else.** These Terms are governed by the laws of the Hong Kong Special Administrative Region. A dispute is first referred to mediation under the HKIAC Mediation Rules. If it is not settled within 30 days of the mediation starting, it is resolved by arbitration administered by HKIAC under the HKIAC Administered Arbitration Rules in force when the notice of arbitration is submitted, before one arbitrator. The seat is Hong Kong and the language is English.",
          "**Individual claims only.** You and we may bring claims only individually, not as a plaintiff or class member in any class, collective or representative action. The arbitrator may not consolidate claims. This waiver is a material part of these Terms.",
          "**Exceptions.** Either side may bring an individual claim in a small-claims court in your country of residence, or seek urgent injunctive relief, including to protect intellectual property, in a court of competent jurisdiction.",
          "**Hearings** may be held by video conference. Proceedings are confidential.",
          "**Opt-out.** You may opt out of this section by emailing info@bitty.io within 30 days of first accepting these Terms, giving your name and the addresses you use with the Services. Disputes are then resolved by the courts named in the next item.",
          "**Courts.** Anything not subject to arbitration goes to the courts of Tarrant County, Texas if you live in the United States, and the courts of Hong Kong otherwise."
        ]
      },
      {
        "type": "p",
        "text": "This section survives termination. Nothing here removes consumer protections that the law of your country gives you and that cannot be waived."
      }
    ]
  },
  {
    "title": "17. Changes to these Terms",
    "blocks": [
      {
        "type": "p",
        "text": "We may update these Terms, and the date at the top will change when we do. For a material change we will give reasonable notice in the apps or on the website before it takes effect. Continuing to use the Services after it takes effect means you accept it. If you do not, stop using the Services; your vault remains yours."
      }
    ]
  },
  {
    "title": "18. General terms and contact",
    "blocks": [
      {
        "type": "ul",
        "items": [
          "**Entire agreement.** These Terms and the Privacy Policy are the whole agreement between you and us about the Services.",
          "**Assignment.** You may not transfer these Terms. We may transfer them in a merger, acquisition, reorganisation or sale of assets.",
          "**Severability and waiver.** If a provision is unenforceable, the rest stands. Not enforcing a right is not a waiver of it.",
          "**Force majeure.** We are not liable for delays or failures caused by events beyond our reasonable control, including network outages, forks, attacks and changes in law.",
          "**No third-party beneficiaries,** except the Bitty Parties under sections 13 and 14.",
          "**Language.** These Terms are written in English. Translations are for convenience; the English version prevails.",
          "**Notices.** We may give you notice in the apps or on the website. You may reach us at info@bitty.io, Bitty Limited, a company registered in Hong Kong, whose registered office is at Unit 507, 5/F, New East Ocean Centre, No. 9 Science Museum Road, Tsim Sha Tsui East, Hong Kong."
        ]
      }
    ]
  }
];
