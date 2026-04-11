import { useState, useEffect, useCallback, useMemo } from "react";

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
// Replace ENTRA_CLIENT_ID with the Application (client) ID from your Entra ID
// app registration. Replace SHAREPOINT_SITE_ID and SHAREPOINT_LIST_ID after
// running the Graph Explorer queries in SETUP.md.
const ENTRA_CLIENT_ID   = "YOUR_ENTRA_APP_CLIENT_ID";
const SP_SITE_ID        = "YOUR_SHAREPOINT_SITE_ID";
const SP_LIST_ID        = "YOUR_SHAREPOINT_LIST_ID";

const SK = "avs-daily-v1";  // localStorage key (fallback / dev mode)

// ─── TEAMS + GRAPH STORAGE LAYER ─────────────────────────────────────────────
//
// Priority chain:
//   1. Microsoft Graph → SharePoint list  (Teams tab, any identity incl. guests)
//   2. localStorage                        (local dev / non-Teams browser)
//
// The SharePoint list has two columns:
//   UserEmail   (Single line of text, indexed)
//   ProgressData (Multiple lines of text — stores the JSON blob)

let _teamsReady   = false;   // true once microsoftTeams.app.initialize() resolves
let _graphToken   = null;    // cached Graph access token
let _userEmail    = null;    // cached user email from Teams context
let _spItemId     = null;    // cached SharePoint list item ID for this user

// Initialise Teams SDK and fetch the user's email + Graph token.
// Called once at app mount. Returns true if running inside Teams.
async function initTeams() {
  if (typeof microsoftTeams === "undefined") return false;
  try {
    await microsoftTeams.app.initialize();
    const ctx = await microsoftTeams.app.getContext();
    _userEmail = ctx?.user?.loginHint || ctx?.user?.userPrincipalName || null;
    if (!_userEmail) return false;

    // Exchange the Teams SSO token for a Graph-scoped token via the
    // getAuthToken → your Entra app → Graph consent flow.
    _graphToken = await new Promise((resolve, reject) => {
      microsoftTeams.authentication.getAuthToken({
        resources: ["https://graph.microsoft.com"],
        successCallback: resolve,
        failureCallback: reject,
      });
    });

    _teamsReady = !!_graphToken;
    return _teamsReady;
  } catch (e) {
    console.warn("[AVS] Teams init failed, falling back to localStorage:", e);
    return false;
  }
}

// Graph helper — all calls go through here
async function graphFetch(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${_graphToken}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph ${method} ${path} → ${res.status}: ${err}`);
  }
  if (res.status === 204) return null;           // DELETE / no-content responses
  return res.json();
}

// Find (or create) the SharePoint list item for this user.
// Returns the item ID. Cached after first call.
async function getOrCreateSpItem() {
  if (_spItemId) return _spItemId;

  const encoded = encodeURIComponent(_userEmail);
  const filter  = `$filter=fields/UserEmail eq '${encoded}'&$select=id,fields/ProgressData`;
  const result  = await graphFetch(
    `/sites/${SP_SITE_ID}/lists/${SP_LIST_ID}/items?${filter}`
  );

  if (result.value && result.value.length > 0) {
    _spItemId = result.value[0].id;
    return _spItemId;
  }

  // No existing record — create one
  const created = await graphFetch(
    `/sites/${SP_SITE_ID}/lists/${SP_LIST_ID}/items`,
    "POST",
    { fields: { UserEmail: _userEmail, ProgressData: "" } }
  );
  _spItemId = created.id;
  return _spItemId;
}

const storageLayer = {
  get: async () => {
    if (_teamsReady) {
      try {
        const itemId = await getOrCreateSpItem();
        const item   = await graphFetch(
          `/sites/${SP_SITE_ID}/lists/${SP_LIST_ID}/items/${itemId}?$select=fields/ProgressData`
        );
        const raw = item?.fields?.ProgressData;
        return raw && raw.length > 0 ? raw : null;
      } catch (e) {
        console.warn("[AVS] Graph read failed, trying localStorage:", e);
      }
    }
    try { return localStorage.getItem(SK); } catch { return null; }
  },

  set: async (value) => {
    if (_teamsReady) {
      try {
        const itemId = await getOrCreateSpItem();
        await graphFetch(
          `/sites/${SP_SITE_ID}/lists/${SP_LIST_ID}/items/${itemId}/fields`,
          "PATCH",
          { ProgressData: value }
        );
        return;
      } catch (e) {
        console.warn("[AVS] Graph write failed, falling back to localStorage:", e);
      }
    }
    try { localStorage.setItem(SK, value); } catch {}
  },

  del: async () => {
    if (_teamsReady && _spItemId) {
      try {
        await graphFetch(
          `/sites/${SP_SITE_ID}/lists/${SP_LIST_ID}/items/${_spItemId}`,
          "DELETE"
        );
        _spItemId = null;
        return;
      } catch (e) {
        console.warn("[AVS] Graph delete failed:", e);
      }
    }
    try { localStorage.removeItem(SK); } catch {}
  },
};

const LESSONS = [
  {title:"The AI Risk Management Framework",source:"NIST · AI RMF 1.0",insight:"NIST\'s AI RMF provides a voluntary framework for organizations to manage AI risks across four functions: Govern, Map, Measure, and Manage. It is the most widely adopted AI governance reference in the US and is already being cited in federal procurement requirements.",why:"Organizations that cannot demonstrate AI risk governance will face client scrutiny, regulatory pressure, and liability exposure as AI adoption accelerates.",action:"Inventory every AI tool in active use across your organization. For each, ask: who approved it, what data does it access, and what governance process evaluated its risk? The gaps in that inventory are your immediate exposure.",cat:"ai",pillar:"AI & Automation"},
  {title:"The Pilot Trap",source:"McKinsey · The State of AI in 2025",insight:"88% of organizations now use AI in at least one function. Only one-third have scaled beyond pilots. The gap between adoption and transformation is not a technology problem — it is a leadership and organizational design problem. High performers are 3.6× more likely to aim for transformational change and nearly 3× more likely to have fundamentally redesigned workflows around AI rather than layered AI onto existing ones.",why:"Most organizations are stuck in pilot purgatory — running experiments that never become programs. The constraint is almost never the AI technology. It is the absence of leadership commitment to workflow redesign and organizational change.",action:"Audit your organization\'s AI initiatives. Identify which are genuine workflow redesigns and which are AI layered on top of old processes. The latter are pilots. Name them accurately and decide which deserve a path to scale.",cat:"ai",pillar:"AI & Automation"},
  {title:"Responsible AI Governance in Practice",source:"OECD · AI Principles",insight:"The OECD AI Principles — adopted by 46 countries including the US — establish five values-based principles for trustworthy AI: inclusive growth, human-centered values, transparency, robustness, and accountability. These principles underpin most national AI regulatory frameworks.",why:"Understanding the OECD framework helps executives evaluate AI vendors and policies against a globally accepted baseline rather than marketing claims.",action:"When your next AI vendor pitches a product, ask them: how does your system address transparency and accountability under the OECD AI Principles?",cat:"ai",pillar:"AI & Automation"},
  {title:"The IP-Led Value Shift",source:"World Economic Forum · Invest in the Workforce for the AI Age",insight:"The WEF argues that AI will create more jobs than it displaces only if organizations invest deliberately in people and redesign work. The most significant structural shift: organizations are moving from services-led value (selling time and labor) to IP-led value (selling systems, knowledge, and outcomes). AI accelerates this transition by dramatically reducing the cost of producing consistent, repeatable work.",why:"Every professional services organization — and most product companies — faces a version of this transition. The leaders who redesign their value model around AI-augmented capabilities will outperform those who use AI to do the same work faster.",action:"Map your organization\'s current revenue model against the services-to-IP spectrum. Where is AI already enabling repeatable, scalable output? Where are you still billing for time what could be delivered as a system?",cat:"ai",pillar:"AI & Automation"},
  {title:"The Six Levers of AI Value",source:"McKinsey · The State of AI in 2025",insight:"McKinsey\'s research on AI high performers identifies six dimensions essential to capturing value: strategy (AI tied to business priorities), talent (people who can work with AI effectively), operating model (AI embedded in how work is done, not housed in a separate team), technology (infrastructure that enables AI), data (accessible and trustworthy), and adoption (scaled through the organization, not confined to early adopters). Organizations that excel in only two or three consistently underperform those that build all six.",why:"Most organizations invest heavily in technology and data while neglecting strategy alignment, operating model redesign, and systematic adoption. The weakest lever constrains the entire system regardless of how strong the others are.",action:"Rate your organization on all six dimensions (1–5). Identify your two lowest scores. Address those before increasing investment in dimensions where you are already strong.",cat:"ai",pillar:"AI & Automation"},
  {title:"Culture Determines AI Outcomes",source:"McKinsey · Are Your People Ready for AI at Scale?",insight:"AI amplifies what is already true about an organization. Healthy culture, clear operating models, and psychological safety accelerate AI progress. Dysfunctional culture, ambiguous accountability, and siloed data accelerate dysfunction. McKinsey\'s 20+ years of organizational health research supports a single conclusion: the organizations that struggle most with AI are not technology-poor — they are organizationally unhealthy. Technology does not fix culture. Culture determines what technology can accomplish.",why:"Executives who believe they have an AI problem usually have a culture problem. Investing in better AI tools when organizational culture is the constraint produces better tools that get worse adoption.",action:"Identify the top organizational dysfunction in your business. Ask honestly: if AI accelerated that dysfunction by 10×, what would it look like? That answer defines your governance priority before your next AI investment.",cat:"ai",pillar:"AI & Automation"},
  {title:"Where AI Investment Is Going",source:"Stanford HAI · AI Index Report 2025",insight:"The Stanford HAI AI Index documents the scale of the AI investment landscape: US private AI investment reached $109 billion in 2024, more than 12× China\'s. Corporate AI adoption reached 78% of organizations in 2024, up from 55% in 2023. The number of AI models released annually has tripled in three years. Executives making AI strategy decisions need the empirical foundation, not just the narrative — where organizations actually stand versus where they think they stand.",why:"AI investment decisions made without understanding the competitive landscape are guesses. The Stanford data shows adoption is accelerating faster than most organizations' internal assessments reflect. The laggards are further behind than they realize.",action:"Compare your organization\'s AI adoption against the 78% benchmark. Are you ahead, at par, or behind? For each function you have not yet deployed AI in, identify the specific barrier — technology, governance, data, or leadership commitment.",cat:"ai",pillar:"AI & Automation"},
  {title:"What AI Does to Management",source:"Harvard Business Review · How AI Is Redefining Managerial Roles (2025)",insight:"Harvard Business School research finds that generative AI can flatten corporate hierarchy and streamline productivity by freeing managers from project coordination tasks. The strategic question every organization must answer: what to automate, what to augment, and how management itself changes when AI handles coordination, synthesis, and first-draft production. The managers who thrive are those who shift toward judgment, relationship, and exception-handling work.",why:"AI is not just changing what individual contributors do — it is changing what managers are for. Organizations that do not redesign management roles around AI capability will find themselves paying management costs for coordination work that AI already handles.",action:"Map one management role in your organization against this framework: what percentage of that role is coordination and synthesis (AI territory) versus judgment and relationship (human territory)? Use the map to redesign the role, not just add AI tools to it.",cat:"ai",pillar:"AI & Automation"},
  {title:"The Workforce Math",source:"World Economic Forum · Future of Jobs Report 2025",insight:"The WEF projects 170 million new jobs created and 92 million displaced by 2030 — a net gain of 78 million. AI and big data are the fastest-growing skill demand globally. 39% of existing skills are expected to change or become obsolete. Organizational culture and resistance to change rank as the second-largest barrier to transformation, cited by 46% of employers. These are planning inputs, not predictions — the organizations acting on them now are building structural advantage.",why:"Workforce planning that ignores these projections is planning for a world that no longer exists. The organizations that will lead in 2030 are the ones designing their talent model around this data today.",action:"Map your workforce against the WEF projections. Which roles are at highest displacement risk in your industry? Which new capabilities will you need to develop or hire? Commit to one workforce planning action this quarter based on the data.",cat:"ai",pillar:"AI & Automation"},
  {title:"RAG: How AI Connects to Your Data",source:"Lewis et al. · Retrieval-Augmented Generation (2020) / Enterprise Implementation Guides",insight:"Retrieval-Augmented Generation (RAG) is the dominant architecture for grounding AI outputs in an organization\'s actual knowledge base. Rather than relying solely on a model\'s training data, RAG retrieves relevant documents from your systems at query time and uses them as context for generation. Every enterprise AI vendor claiming their system \'connects to your data\' is using some form of RAG. Understanding the architecture lets executives ask the right evaluation questions.",why:"Executives who cannot evaluate RAG-based systems are entirely dependent on vendor claims. The key questions — what is being indexed, how is retrieval quality measured, what happens when retrieved context is wrong — require understanding the architecture.",action:"For any AI tool your organization is evaluating that accesses internal documents, ask three questions: What gets indexed and how often is it updated? How do you measure retrieval accuracy? What happens when the retrieved context contradicts the correct answer?",cat:"ai",pillar:"AI & Automation"},
  {title:"Smart Contracts and Legal Enforceability",source:"Sideman & Bancroft · Smart Contracts Revisited: Lessons from the Courts (2025)",insight:"Smart contracts are self-executing code stored on a blockchain that automatically enforce agreement terms when predefined conditions are met. Courts are actively working through enforceability questions: whether smart contract code constitutes a binding agreement, how disputes are resolved when code executes contrary to intent, and how existing commercial law frameworks apply to autonomous execution. The legal landscape is unsettled but developing rapidly through case law and emerging legislation.",why:"Organizations deploying smart contracts for payments, supply chain coordination, or asset transfer are making commitments that execute automatically — without the friction of traditional contract enforcement. Understanding the enforceability landscape is essential before deployment, not after a dispute.",action:"If your organization is evaluating or has deployed smart contracts, verify two things: what jurisdiction governs the agreement, and what is the recourse mechanism if the contract executes contrary to intent? Automatic execution is not the same as legally sound execution.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Digital Identity and Client Verification",source:"NIST · Digital Identity Guidelines SP 800-63",insight:"NIST SP 800-63 defines three assurance levels for digital identity verification — the framework underpinning how organizations establish that a person is who they claim to be. Level 1 covers basic self-attestation. Level 2 requires remote identity proofing. Level 3 requires in-person or supervised remote verification. The assurance level required for a transaction is determined by the risk of getting it wrong.",why:"Every digital transaction, account access, and remote onboarding process carries identity risk. Organizations that cannot demonstrate the appropriate assurance level for their use case face regulatory exposure and liability when impersonation fraud occurs.",action:"Map your organization's key identity verification touchpoints against the NIST 800-63 assurance levels. For each, ask: does the assurance level match the risk of the transaction? Where gaps exist, that is your identity infrastructure priority.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"The CBDC Landscape",source:"MIT Digital Currency Initiative · Research and Publications",insight:"130+ countries are actively exploring Central Bank Digital Currencies. The Bahamas, Jamaica, Nigeria, and the Eastern Caribbean Union have launched. China\'s digital yuan is in broad deployment. The EU digital euro and US digital dollar remain under research and political debate. CBDCs differ fundamentally from cryptocurrencies: they are government-issued, centrally controlled, and programmable — spending rules can be embedded in the currency itself. MIT\'s Digital Currency Initiative provides the most rigorous academic research on CBDC architecture, privacy implications, and economic impact.",why:"CBDCs will reshape payment infrastructure, monetary policy transmission, and financial inclusion. Organizations in financial services, retail, supply chain, and international trade need to understand the landscape before it becomes operational infrastructure.",action:"Assess your organization\'s payment infrastructure. If CBDCs deploy broadly in markets you operate in, what changes? Consider payment processing, privacy obligations, regulatory reporting, and cross-border transactions.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Post-Quantum Risk for Blockchain",source:"NIST · Post-Quantum Cryptography Standards (FIPS 203, 204, 205)",insight:"Blockchain systems rely on elliptic curve cryptography (ECDSA) for digital signatures and key management. Sufficiently powerful quantum computers could break ECDSA, potentially allowing retroactive compromise of historical blockchain records and active theft of digital assets. NIST finalized three post-quantum cryptographic standards in August 2024: FIPS 203 (ML-KEM), FIPS 204 (ML-DSA), and FIPS 205 (SLH-DSA). Organizations with long-term blockchain deployments or significant digital assets should begin migration planning now.",why:"The threat is not immediate — but cryptographic migration timelines are long, often 5–10 years for large organizations. The \'harvest now, decrypt later\' attack is already underway: adversaries are collecting encrypted data today to decrypt once quantum capability arrives.",action:"Identify any blockchain infrastructure your organization depends on. Ask your technology team: what is the post-quantum migration plan for the cryptographic primitives underlying this system? If there is no plan, that is the answer.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Tokenization of Real-World Assets",source:"World Economic Forum · Digital Assets Regulation Report 2025",insight:"Real-world asset tokenization — converting property, securities, and receivables into blockchain tokens — is projected to represent $16 trillion in assets by 2030. Regulatory frameworks are emerging but fragmented across jurisdictions, creating compliance complexity for early movers.",why:"Tokenization is moving from pilot to scale across real estate, private equity, trade finance, and infrastructure. Organizations that understand the regulatory landscape now will be positioned to move when windows open — rather than spending that window on basic education.",action:"Identify one asset class relevant to your organization or clients where tokenization is actively discussed. Research the current regulatory position in your primary jurisdiction. That research is the prerequisite to any strategic decision on participation.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"The NIST Cybersecurity Framework 2.0",source:"NIST · Cybersecurity Framework 2.0 (2024)",insight:"NIST CSF 2.0 expanded the original five functions (Identify, Protect, Detect, Respond, Recover) with a sixth: Govern. The Govern function explicitly elevates cybersecurity to an enterprise risk management and board-level responsibility — not just an IT function.",why:"Regulators, insurers, and enterprise customers increasingly expect organizations to demonstrate governance-level cybersecurity oversight — not just technical controls. CSF 2.0 is the reference framework against which that expectation is evaluated.",action:"Ask your IT or security lead: are our cybersecurity practices mapped to NIST CSF 2.0? If not, download the framework and identify the single biggest gap between your current state and what the Govern function requires. Start there.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Post-Quantum Cryptography: The Long Game",source:"NIST · FIPS 203, 204, 205 — Post-Quantum Cryptography Standards (August 2024)",insight:"NIST finalized three post-quantum cryptographic standards in August 2024, replacing RSA and elliptic curve cryptography that quantum computers could eventually break. FIPS 203 (ML-KEM) for key encapsulation, FIPS 204 (ML-DSA) and FIPS 205 (SLH-DSA) for digital signatures. Federal agencies have been directed to complete migration by 2035. The immediate threat is \'harvest now, decrypt later\': adversaries collecting encrypted data today, intending to decrypt it once quantum computers are powerful enough.",why:"Organizations handling data that must remain confidential for 10+ years — health records, financial data, intellectual property, government contracts — face exposure from this threat today, not in the future. Migration planning has a long lead time.",action:"Identify your organization\'s most sensitive data categories. How long must each remain confidential? If the answer exceeds five years for any category, begin a conversation about post-quantum migration readiness with your technology team.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Zero Trust Architecture",source:"CISA · Zero Trust Maturity Model 2.0",insight:"Zero Trust replaces the assumption that everything inside a network perimeter is safe. Instead, every user, device, and application must continuously verify identity before accessing resources. CISA\'s Maturity Model provides a five-pillar roadmap: Identity, Devices, Networks, Applications, and Data.",why:"Organizations are high-value targets because of the sensitive operational and customer data they hold. Perimeter-based security alone is no longer adequate and is explicitly insufficient under current cyber insurance underwriting standards.",action:"Ask your IT team: do we operate on a zero-trust model or a perimeter model? If perimeter, what would it take to begin the migration?",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Vendor and Supply Chain Cyber Risk",source:"WEF · Global Cybersecurity Outlook 2025 / CISA · Supply Chain Risk Management Guidance",insight:"Supply chain and third-party risk is the defining cybersecurity challenge of the enterprise era. The WEF Global Cybersecurity Outlook 2025 identifies it as a top systemic risk: a single trusted vendor compromise — SolarWinds, MOVEit, and multiple major platform breaches in 2024–2026 — can cascade into hundreds of downstream organizations simultaneously. Most organizations have limited visibility into their vendors' security posture beyond contractual attestations.",why:"Your cybersecurity posture is only as strong as your most vulnerable vendor. The attack surface you manage extends to every system, platform, and service provider with access to your data or infrastructure — most of which you do not directly control.",action:"List your top ten technology vendors and service providers. For each, document: what data do they access, do you have their current SOC 2 Type II report, and what is your contingency plan if they are compromised? Gaps in this inventory are gaps in your security posture.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Cyber Insurance and the New Underwriting Reality",source:"Marsh · Cyber Insurance Market Report 2025",insight:"Cyber insurers now routinely require MFA on all remote access, endpoint detection and response tools, privileged access management, and documented incident response plans as conditions of coverage. Organizations that cannot demonstrate these controls face premium increases or denial of coverage.",why:"A cyberattack without adequate insurance coverage can be catastrophic. Coverage gaps discovered during a claim cannot be remediated retroactively.",action:"Pull your current cyber insurance policy and the underwriting questionnaire you completed. Verify your answers are still accurate — misrepresentation voids coverage.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Data Governance Fundamentals",source:"DAMA International · Data Management Body of Knowledge",insight:"Data governance is the system of decision rights and accountabilities for data-related processes. Effective governance defines who can take what actions with what data, under what circumstances, using what methods. Without it, data quality, privacy compliance, and AI readiness are impossible.",why:"Every organization generating AI-assisted outputs, handling customer data across cloud platforms, or operating under data privacy regulation needs data governance — not as an IT project, but as an enterprise-wide operating standard. Without it, AI readiness is impossible and privacy compliance is theater.",action:"Identify who in your organization is accountable for data quality and data access decisions. If you cannot name a specific person for each, that ambiguity is the governance gap — and it affects every data-dependent decision your organization makes.",cat:"data",pillar:"Data & Analytics"},
  {title:"Privacy by Design",source:"NIST Privacy Framework · Ann Cavoukian / ISO/IEC 27701",insight:"Privacy by Design means building data protection into systems and processes from the outset — not retrofitting compliance after the fact. The seven foundational principles: proactive not reactive, privacy as the default, built into design, full functionality (not zero-sum), end-to-end security, visibility and transparency, and respect for user privacy. Required under GDPR Article 25, referenced in CCPA, and operationalized through the NIST Privacy Framework. Organizations that implement it reduce regulatory exposure and build customer trust simultaneously.",why:"Retrofitting privacy compliance into existing systems is expensive, incomplete, and creates ongoing technical debt. Organizations building new data workflows, AI systems, or digital products have a narrow window to build privacy in correctly.",action:"Identify one new data initiative your organization is launching. Before deployment, apply the Privacy by Design checklist: what personal data is collected, is it the minimum necessary, how is it protected by default, and what is the data subject\'s control mechanism?",cat:"data",pillar:"Data & Analytics"},
  {title:"The Data-Driven Enterprise",source:"McKinsey · The Data-Driven Enterprise of 2025",insight:"McKinsey\'s vision of a mature data-driven organization: data embedded in every decision, analytics literacy across the workforce, automated governance, and data leadership as a value-generating executive function rather than a cost center. Organizations in the top quartile of data maturity report 20–30% higher performance margins than industry average. The gap between stated commitment to data-driven decision-making and actual organizational behavior is the defining challenge of enterprise data programs.",why:"Most organizations have invested heavily in data infrastructure without becoming genuinely data-driven. The constraint is almost never technology — it is leadership behavior, incentive structures, and the willingness to act on analysis that contradicts intuition.",action:"Name one significant decision your organization made in the past quarter. What data informed it? Was that data produced by your existing infrastructure? If the answer reveals a gap, that gap is your data program\'s real priority.",cat:"data",pillar:"Data & Analytics"},
  {title:"Data Governance as Strategy",source:"Deloitte · Chief Data Officer Survey 2025",insight:"Data governance is not compliance overhead — it is the foundation of data trust. The Deloitte CDO Survey finds governance is the top CDO priority for 51% of organizations. Without governance, organizations have data people do not trust, analyses that contradict each other across departments, and AI systems trained on whatever data was accessible rather than data that was verified. Organizations that treat governance as strategy — building it deliberately before scaling analytics — consistently outperform those that treat it as a cost center.",why:"Until the data is trustworthy, every downstream investment in analytics and AI is compounding an unresolved structural problem. Analytics on untrustworthy data produces confident wrong answers. AI on untrustworthy data produces confident wrong decisions at scale.",action:"Map your data governance maturity: do you have a data catalog, data quality standards, data lineage tracking, and a defined data ownership model? Each missing element is a governance gap affecting every decision that depends on data.",cat:"data",pillar:"Data & Analytics"},
  {title:"Analytics Maturity in Professional Services",source:"Davenport & Bean · 2025 AI and Data Leadership Benchmark",insight:"Only 26% of organizations report a genuinely data-driven culture despite 84% of large enterprises having appointed a Chief Data Officer. The Davenport-Bean benchmark — tracking Fortune 1000 data leadership since 2012 — finds investment in data leadership is near-universal; operational maturity is not. The gap is not resources. It is the absence of decision-making processes that require and reward data use.",why:"Appointing a CDO or buying analytics tools does not produce data maturity. Culture, process, and decision-making integration determine whether the investment produces value.",action:"Ask your data or IT lead: name one business decision in the past quarter that was changed because of data analysis. If they struggle to answer, that is your baseline.",cat:"data",pillar:"Data & Analytics"},
  {title:"The Board\'s Cybersecurity Responsibility",source:"SEC · Cybersecurity Disclosure Rules (2023)",insight:"The SEC\'s 2023 cybersecurity rules require public companies to disclose material cybersecurity incidents within four days and to annually disclose board-level cybersecurity oversight processes. The rules signal that cybersecurity governance is now a board-level accountability, not just a management function.",why:"Public companies are now legally required to disclose board-level cyber governance processes annually. This has elevated cybersecurity from an IT concern to a board accountability — and the same expectations are migrating to private companies through insurance requirements, enterprise customer due diligence, and investor scrutiny.",action:"Assess your organization's cybersecurity governance posture against the SEC disclosure standard: could you describe your board-level cybersecurity oversight process substantively if required to? If not, that gap is both a governance risk and, for public companies, a disclosure obligation.",cat:"governance",pillar:"Governance & Risk"},
  {title:"AI Governance at the Board Level",source:"Deloitte · Board Practices Report: AI Oversight 2025",insight:"Only 39% of boards have a formal AI oversight process despite 78% identifying AI as a top strategic risk. Deloitte identifies five board-level AI governance responsibilities: risk oversight, ethics and values alignment, regulatory compliance monitoring, talent and capability assessment, and strategic value realization.",why:"Boards are now being asked directly about AI governance by shareholders, regulators, and insurers — and 61% cannot answer substantively. Organizations with board-level AI oversight demonstrate lower risk profiles, attract better terms from insurers, and build more durable stakeholder trust.",action:"Assess your own board or leadership team against Deloitte's five responsibilities. Which is least developed? For most organizations it is regulatory compliance monitoring — the board has no structured process for tracking the AI regulatory landscape. That is where board-level AI governance work should begin.",cat:"governance",pillar:"Governance & Risk"},
  {title:"Technology as Competitive Advantage",source:"Harvard Business Review · Digital Transformation in Professional Services",insight:"Organizations that treat technology investment as overhead rather than competitive capability consistently underperform peers on growth, margin, and customer retention. The differentiator between technology leaders and laggards is rarely the technology chosen — it is the leadership capacity to select, deploy, and extract value from it.",why:"Technology fluency at the leadership level is what separates organizations that successfully deploy AI from those that buy tools and accumulate friction. The investment is often identical. The return is determined by leadership engagement.",action:"Identify one technology investment your organization made in the past two years. Assess honestly: was leadership engaged enough in the deployment to drive adoption? If the tool is underused, the gap is almost certainly leadership engagement, not the technology itself.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Leading Through Digital Transformation",source:"MIT Sloan Management Review · Digital Leadership Capabilities 2025",insight:"MIT Sloan research identifies three capabilities that distinguish effective digital leaders: the ability to translate between business strategy and technology capability, a tolerance for iterative experimentation, and the habit of continuous technology learning. The third is the rarest and most impactful.",why:"Executives who stop learning about technology become dependent on advisors who may not share their strategic interests. Continuous learning is a leadership discipline, not a hobby.",action:"Identify one technology topic directly relevant to your organization's strategy that you do not fully understand. Commit to one hour of structured learning on it this week — not passive reading, but active engagement with a primary source.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"The Conscious Competence of Technology",source:"Gordon Training International · Conscious Competence Model",insight:"Leaders move through four stages in any new domain: unconscious incompetence (don\'t know what you don\'t know), conscious incompetence (aware of the gap), conscious competence (capable with effort), unconscious competence (fluent). Most executives are at stage one or two on AI. Recognizing that honestly is the prerequisite to progress.",why:"The executives most at risk are those who believe they understand AI because they use ChatGPT occasionally. Awareness of the gap is the beginning of genuine competence.",action:"Pick one of the four pillars — AI, Cybersecurity, Blockchain, or Data — that is directly relevant to your organization's strategy. Honestly assess which of the four stages you currently occupy. Write it down. That honest assessment, not your title or tenure, is your actual development starting point.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Technology ROI: Measuring What Matters",source:"McKinsey · Rewired / Harvard Business Review · Measuring Digital ROI",insight:"Organizations consistently struggle to measure technology ROI because they measure inputs (spend, tools deployed, users onboarded) rather than outcomes (revenue impact, cost reduction, cycle time, customer experience). McKinsey\'s research on digital transformation leaders finds they define ROI targets before deployment, measure at the business outcome level not the technology level, and hold business owners — not IT — accountable for results. Technology investment without outcome accountability is cost, not investment.",why:"Technology investments that cannot be connected to business outcomes lose budget priority and executive attention. Leaders who define the outcome measurement framework before deployment get better results and more durable organizational commitment.",action:"Identify your largest technology investment of the past 18 months. What specific business outcome was it designed to produce? How are you measuring that outcome today? If the answer is unclear, define the metric now and establish a baseline.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Prompt Engineering for Executives",source:"Google · Prompting Essentials / Anthropic · Prompt Engineering Guide",insight:"Effective AI prompting follows a five-part structure applicable to any generative AI tool: role (who you want the AI to be), context (relevant background the AI needs), task (exactly what you want produced), format (how you want the output structured), and constraints (what to exclude or avoid). Executives who develop this skill consistently outperform peers using AI casually — not because of technical sophistication, but because they communicate intent precisely. The output quality ceiling is set by the input quality floor.",why:"The gap between useful AI output and frustrating AI output is almost entirely explained by prompt quality. Leaders who invest 30 minutes learning prompt structure unlock significantly more value from the same tools their peers already have.",action:"Rebuild the last AI prompt you used for a work task. Apply the five-part structure: role, context, task, format, constraints. Compare the output quality to your original. The difference is your prompt engineering dividend.",cat:"ai",pillar:"AI & Automation"},
  {title:"The Agentic AI Shift",source:"McKinsey \u00b7 The Agentic Organization (2025)",insight:"Agentic AI systems can perform multi-step, autonomous work \u2014 researching, deciding, and executing across systems without human intervention at each step. McKinsey\\'s framework describes how organizations must evolve across five dimensions as agents become capable of handling workflows that currently require human coordination.",why:"The organizations planning now for agentic AI workflows will define the next competitive benchmark. Those waiting until agents are mainstream will be reacting rather than leading.",action:"Identify one multi-step workflow in your organization that currently involves three or more handoffs between people. Sketch what it looks like with AI agents handling the coordination. What human oversight points would you preserve, and why?",cat:"ai",pillar:"AI & Automation"},
  {title:"AI Maturity: Where Your Organization Actually Stands",source:"MIT Sloan CISR \u00b7 How to Boost Your Organization\\'s AI Maturity Level (2025)",insight:"MIT CISR research identifies four AI maturity stages and four factors required to advance: strategy alignment (AI tied to firm strategy), modular technology architecture, workforce synchronization (skills and incentives aligned to AI-augmented work), and responsible stewardship (governance that builds trust). Most firms are between stages one and two. The bottleneck is governance, not the AI tools themselves.",why:"Knowing your actual maturity stage prevents over-investing in AI capabilities your organization isn\\'t ready to use \u2014 and identifies the specific constraint slowing progress.",action:"Assess your organization against the four factors. Which is your weakest? That is your AI program\\'s real constraint \u2014 not the tool you are choosing between.",cat:"ai",pillar:"AI & Automation"},
  {title:"UCC Article 12 and Digital Asset Transactions",source:"Uniform Law Commission \u00b7 UCC Article 12 \u2014 Controllable Electronic Records",insight:"UCC Article 12, now adopted by a growing number of US states, provides the legal framework for transferable records on distributed ledgers \u2014 including tokens and smart contract outputs. It defines how controllable electronic records are created, transferred, and perfected under commercial law, giving blockchain-based transactions enforceable legal standing.",why:"Without Article 12 (or equivalent legislation), your clients\\'s blockchain-based agreements may execute automatically but lack clear legal enforceability in disputes. Knowing which states have adopted it is prerequisite to advising on digital asset transactions.",action:"Verify whether the states where your clients\\'s key digital asset transactions will be enforced have adopted UCC Article 12. If not, their agreements need traditional legal wrappers.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Digital Identity Wallets: The eIDAS Mandate",source:"European Commission \u00b7 eIDAS 2.0 Regulation (2024)",insight:"EU eIDAS 2.0 requires every EU member state to offer a digital identity wallet to citizens by September 2026 and mandates private-sector acceptance by December 2027. Built on W3C Verifiable Credentials, this is the first legally binding government mandate for decentralized digital identity at continental scale \u2014 440 million people.",why:"Organizations that interact with EU clients, regulators, or counterparties will be expected to accept digital credential presentations. The infrastructure standards being implemented in Europe are the same ones the rest of the world will adopt.",action:"Evaluate your client identity verification processes. Which currently require physical or paper documents? Identify which could be replaced by a digital credential \u2014 and whether your systems could verify one.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"When Blockchain Is the Right Solution",source:"World Economic Forum \u00b7 Blockchain Beyond the Hype",insight:"The WEF\\'s strategic filter: blockchain creates genuine value when three conditions are present \u2014 multiple parties need shared access to data, no single party is trusted by all others to control the record, and the value of an immutable, verifiable audit trail justifies the complexity and cost. When fewer than three conditions are met, a conventional database is better.",why:"Organizations are regularly pitched blockchain solutions to problems a conventional database would solve better. This filter transforms vendor enthusiasm into a structured evaluation — and gives you a principled basis for the decision.",action:"Apply the three-condition test to the next blockchain initiative you evaluate — whether vendor-pitched, partner-proposed, or internally conceived. How many of the three conditions are genuinely met? If fewer than all three, the answer is a conventional database. That clarity is the value.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Ransomware Response: The First 12 Hours",source:"CISA \u00b7 StopRansomware.gov \u2014 Incident Response Playbook",insight:"Ransomware is a leadership problem more than a technical one. The decisions that determine outcome are made in the first 12 hours: whether to engage with attackers, whether to pay, what to communicate publicly, when to notify law enforcement and regulators, and how to sustain operations. These are executive decisions. Organizations that have exercised their response plan survive better \u2014 those that haven\\'t improvise, and improvisation is expensive.",why:"A ransomware incident would simultaneously trigger customer and regulatory notification obligations, cyber insurance claims processes, and operational disruption. None of these can be managed well without prior planning.",action:"Put this question to your leadership team: if ransomware encrypted 80% of our operational systems at 6am tomorrow, what happens in the first four hours? Who makes which decisions, in what sequence, and with what authority? If the room cannot answer clearly, that is your tabletop exercise brief.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Cyber Insurance: What the Policy Actually Covers",source:"RAND Corporation \u00b7 Cyber Insurance Research",insight:"Cyber insurance is a risk transfer mechanism for residual risk after controls are implemented \u2014 not a substitute for security. Key coverage questions: Does your policy cover ransomware payments? What are the business interruption limits and waiting period? What security controls are required as a condition of the policy remaining valid? Many organizations discover coverage gaps only after a claim is filed — at which point remediation is impossible.",why:"A cyberattack without adequate insurance coverage can be catastrophic. Coverage that appeared valid at purchase may not pay out if required controls were absent or misrepresented during underwriting.",action:"Pull your current cyber insurance policy. Verify three things: ransomware payment coverage, business interruption limits and waiting period, and the specific controls required to maintain valid coverage.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Third-Party and Vendor Cyber Risk",source:"WEF \u00b7 Global Cybersecurity Outlook 2025",insight:"54% of organizations cite supply chain risk as a significant barrier to cyber resilience, yet most have limited visibility into their vendors' security posture beyond contractual attestations. SolarWinds, MOVEit, and multiple major SaaS platform compromises in 2024–2026 all followed the same pattern: a trusted vendor became the attack vector into hundreds of downstream organizations simultaneously.",why:"Every technology platform you use \u2014 document management, cloud storage, customer portals, and billing systems \u2014 is a potential entry point. Vendor risk is your risk.",action:"List your top five technology vendors. For each: What data do they access? Do you have their current SOC 2 report? What is your contingency if they are compromised? Gaps on any of these are open exposure.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Data Quality as the Foundation of AI",source:"NIST \u00b7 Big Data Interoperability Framework SP 1500",insight:"Every AI and analytics system is only as good as the data it processes. Data quality has six dimensions: accuracy, completeness, consistency, timeliness, validity, and uniqueness. Most firms discover data quality problems when an AI system produces an obviously wrong output \u2014 meaning they have been making decisions on bad data for years without knowing it. Quality cannot be added after the fact.",why:"Organizations investing in AI-assisted analysis, automation, and decision support will find those investments underperform if the underlying data is inconsistent, incomplete, or poorly structured.",action:"Pull a sample of 50 project records from your most business-critical data system. Evaluate against the six quality dimensions. The error rate you find is the error rate in every analysis you\\'ve run using that system.",cat:"data",pillar:"Data & Analytics"},
  {title:"The FAIR Data Principles",source:"GO FAIR Foundation \u00b7 FAIR Data Principles",insight:"FAIR stands for Findable, Accessible, Interoperable, and Reusable. The 15 FAIR principles define what it means for data to be genuinely useful \u2014 not just stored. Findable means data has persistent identifiers and descriptive metadata. Accessible means retrieval protocols are open. Interoperable means standard formats. Reusable means clear provenance and licensing. FAIR is the global standard for evaluating whether data can support AI and analytics.",why:"Data that is not FAIR cannot be effectively used by AI systems \u2014 regardless of how much of it you have. Organizations that curate their operational and customer data to FAIR standards will have a compounding AI advantage over those that don\\'t.",action:"Evaluate your organization's primary data asset against the four FAIR dimensions. Where does it fail? Each failure point reduces the value of every analytics investment you make on top of it.",cat:"data",pillar:"Data & Analytics"},
  {title:"Five Ways a Data Strategy Fails",source:"Harvard Business Review \u00b7 5 Ways Your Data Strategy Can Fail (Redman)",insight:"Redman identifies three prerequisites for data strategy success: quality data people trust, a means to create value from it, and organizational capability \u2014 talent, structure, and culture. Five failure modes when prerequisites are absent: building analytics before the data is trustworthy; focusing on collection without a value thesis; ignoring organizational change; treating data as an IT project; moving faster than the organization can absorb.",why:"Most organizational data initiatives fail at prerequisite one \u2014 the data quality problem nobody wants to fund fixing. Analytics on untrustworthy data produces confident wrong answers.",action:"Assess your organization's data initiative against the three prerequisites. Which is weakest? If it is data quality, address it before any other investment.",cat:"data",pillar:"Data & Analytics"},
  {title:"The WEF 360\u00b0 AI Governance Framework",source:"World Economic Forum \u00b7 Governance in the Age of Generative AI (2025)",insight:"The WEF\\'s three-pillar governance framework addresses the full temporal scope of AI governance: Harness the Past (learn from historical AI governance successes and failures before deploying), Build the Present (establish accountability mechanisms and transparency requirements for current deployments), and Plan the Future (build adaptive governance capacity that keeps pace with AI capability changes). Most organizations address only the middle pillar.",why:"Organizations that govern only current AI deployments will be perpetually reacting to new capabilities. Adaptive governance \u2014 built to evolve \u2014 is the durable competitive advantage.",action:"Evaluate your AI governance program against all three pillars. Have you documented lessons from past AI initiatives? Do you have processes that update as capabilities change? Identify your weakest pillar.",cat:"governance",pillar:"Governance & Risk"},
  {title:"Federal AI Policy Direction",source:"Bipartisan House Task Force \u00b7 Report on Artificial Intelligence (December 2024)",insight:"The December 2024 Bipartisan House Task Force Report signals the US will pursue sector-specific AI regulation rather than a comprehensive AI Act. Data privacy and intellectual property protections are central concerns. Federal preemption of state AI laws is actively debated \u2014 the outcome will determine whether state-level AI frameworks survive or are superseded by federal standards.",why:"Federal AI regulation will ultimately set the floor for every organization operating in the US. Understanding the direction now — before it is finalized — enables compliance postures that will not require expensive rework when federal standards preempt state-level frameworks.",action:"Review the Task Force report's sector-specific recommendations for your industry. Federal AI regulation will reflect industry-specific risk profiles \u2014 understanding those recommendations positions you ahead of the curve.",cat:"governance",pillar:"Governance & Risk"},
  {title:"Three Horizons: Balancing Technology Investment",source:"McKinsey \u00b7 Three Horizons of Growth Framework",insight:"McKinsey\\'s Three Horizons framework balances investment across Horizon 1 (sustaining current operations \u2014 short-term), Horizon 2 (emerging opportunities \u2014 medium-term), and Horizon 3 (transformative possibilities \u2014 long-term). Applied to technology investment: organizations that fund only Horizon 1 optimize for today at the cost of future relevance. The benchmark allocation is roughly 70/20/10.",why:"Most organizations allocate 95%+ of technology budget to Horizon 1 \u2014 maintaining existing systems. The firms that will lead in five years are investing deliberately in Horizon 2 and 3 today.",action:"Allocate your current technology investment portfolio across the three horizons. Compare to the 70/20/10 benchmark. Where does your allocation differ \u2014 and is that difference intentional?",cat:"governance",pillar:"Governance & Risk"},
  {title:"The Intelligence Metabolism Operating System",source:"The AV Studio \u00b7 Intelligence Metabolism Framework",insight:"Intelligence Metabolism is a three-stage operating system for leading in a continuous information environment: Intake (systematic scanning of high-quality sources across your technology domains, filtered by relevance to actual decisions), Synthesis (converting raw intelligence into strategic insight \u2014 not summarizing but interpreting, connecting, and generating implications), and Activation (deploying synthesized intelligence in decisions, stakeholder conversations, and organizational strategy). Most leaders have strong Intake but weak Synthesis and almost no deliberate Activation.",why:"The gap between what you read and what you do with it is your intelligence metabolism deficit. Leaders who close that gap consistently make better technology decisions and create more value in client relationships.",action:"Define your current Intake sources, your Synthesis practice, and your Activation pattern. Identify the weakest stage and build one concrete practice to strengthen it this week.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"The Hybrid AI/Expert Model",source:"The AV Studio \u00b7 Coaching Practice Design",insight:"The hybrid AI/expert model is the operating system of high-performing professional practices: AI handles volume \u2014 research, synthesis, document generation, pattern detection. Human experts handle irreplaceable work \u2014 strategic judgment, ethical discernment, client relationships, and decisions where being wrong has consequences. Organizations that treat AI as a replacement for human judgment degrade decision quality. Those that use AI as a force multiplier for expertise outperform both pure-AI and pure-human approaches.",why:"This is the design question every organization must answer deliberately: where does AI work for us, and where does it work with us? The answer determines your staffing model, your supervision requirements, and your competitive positioning.",action:"Map your own work against the hybrid model. Which tasks are volume tasks AI could handle? Which require your specific judgment and expertise? Redesign one workflow to invest your time where you are irreplaceable.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Peer-to-Peer, Insight-Led Positioning",source:"The AV Studio \u00b7 Client Development Philosophy",insight:"The most durable professional relationships in technology-adjacent advisory work are built on insight delivery, not sales activity. Leaders who deliver genuine intelligence \u2014 sharing a relevant research finding, a regulatory development that affects a client\\'s decision, an analysis that reframes a problem \u2014 build trust that persists. Those who lead with credentials and services build transactions that erode. In every context, the question is the same: am I delivering value or requesting it?",why:"Technology fluency creates a client development advantage only if it is activated through relationship touchpoints. The executive leader who shares a relevant AI regulatory update with a client CEO is providing value that no pitch can replicate.",action:"Identify one person in your professional network who would benefit from something specific you know today \u2014 a regulatory development, a case, a research finding. Send it with no ask attached. Do this once per week for 90 days.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"What AI Can and Cannot Do",source:"DeepLearning.AI \u00b7 AI for Everyone (Andrew Ng)",insight:"AI excels at pattern recognition, classification, prediction from labeled data, and generating plausible text outputs. It does not reason, understand context the way humans do, or reliably handle edge cases outside its training distribution. The professional who understands this distinction makes sound adoption decisions. The one who doesn\\'t will over-invest in AI for problems it cannot solve and under-invest where it genuinely accelerates outcomes.",why:"Overstating AI capability leads to misplaced reliance and operational risk. Understating it leads to competitive disadvantage. Understating it leads to competitive disadvantage. The accurate map is the starting point for every other AI decision.",action:"Pick one AI tool your organization uses or is evaluating. Write down three things it does reliably well and two things you cannot trust it to do without human review and judgment. Keep the list visible.",cat:"ai",pillar:"AI & Automation"},
  {title:"The Three Fusion Skills",source:"Harvard Business Review \u00b7 Embracing Gen AI at Work (Wilson & Daugherty, 2024)",insight:"Executives who get the most from AI have three skills: intelligent interrogation (asking AI better questions and iterating to improve outputs), judgment integration (applying professional discernment to what AI produces before acting), and creative orchestration (designing workflows that combine human and AI strengths optimally). These are professional skills, not technical ones, and they compound with deliberate practice.",why:"Professionals who develop these skills consistently outperform peers using AI casually \u2014 not because of the tool they use, but because they know how to extract value from it.",action:"In your next AI-assisted task, consciously apply all three: interrogate more carefully, edit with professional judgment, and ask whether your workflow structure actually optimizes the division of work.",cat:"ai",pillar:"AI & Automation"},
  {title:"What Blockchain Actually Does",source:"NIST \u00b7 IR 8202 \u2014 Blockchain Technology Overview",insight:"A blockchain is a distributed ledger shared across multiple parties where records are cryptographically linked, append-only, and tamper-evident. It solves one specific problem: establishing trusted records among parties who do not trust each other without requiring a central authority. It does not make records accurate. It does not guarantee privacy by default. It is slower than a database. Executives who understand what it actually does can evaluate claims honestly.",why:"The majority of blockchain pitches misrepresent what the technology does. Understanding the baseline lets you serve as an informed advisor rather than a credulous buyer.",action:"The next time blockchain is proposed as a solution — by a vendor, a partner, or internally, ask: what is the trust deficit between parties that a database controlled by one of them cannot solve? That question determines fit.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Building a Blockchain Business Case",source:"World Economic Forum \u00b7 Building Value with Blockchain Technology",insight:"The WEF\\'s four-step business case framework, drawn from 79 real blockchain projects: (1) identify the value at stake by mapping trust gaps, (2) define the value driver \u2014 cost reduction, revenue, risk mitigation, or competitive advantage, (3) quantify value using metrics specific to the trust problem, (4) assess ecosystem readiness \u2014 blockchain requires consortium participation, and solo deployments rarely capture the value proposition. Most failed blockchain initiatives skipped step four.",why:"Organizations pursuing blockchain initiatives without ecosystem analysis consistently waste significant resources. This framework provides the due diligence structure that prevents that.",action:"Apply this four-step framework to any blockchain initiative under evaluation. If step four reveals insufficient ecosystem participation, that is the answer \u2014 regardless of the technology\\'s merit.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"The Supply Chain Transparency Play",source:"Harvard Business Review \u00b7 Building a Transparent Supply Chain (Gaur & Gaiha, 2020)",insight:"Blockchain creates competitive advantage in supply chains not through efficiency but through verifiable provenance. When customers, regulators, and partners can independently verify the origin, handling, and authenticity of goods, trust becomes a product attribute. The HBR analysis frames this as a strategic tool for differentiation \u2014 organizations that build verifiable supply chain transparency first create switching costs and barriers to entry.",why:"Organizations in manufacturing, food and beverage, pharmaceutical, and logistics face mounting pressure from regulators and enterprise buyers to demonstrate supply chain transparency. Blockchain is one of the primary architectures being deployed to meet that requirement.",action:"Identify one supply chain relationship — with a supplier, customer, or partner — where provenance and trust are live concerns. Research whether your sector has emerging blockchain transparency standards or regulatory requirements. That research is the prerequisite to any architecture decision.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"The Regulatory Map: MiCA and Digital Assets",source:"European Commission \u00b7 Markets in Crypto-Assets Regulation (MiCA)",insight:"The EU\\'s MiCA regulation \u2014 the world\\'s first comprehensive digital asset framework \u2014 establishes licensing requirements for crypto-asset service providers, reserve requirements for stablecoins, and market abuse rules. Stablecoin provisions took effect June 2024; full scope by December 2024. Even US-only organizations encounter MiCA through EU vendors, multinational counterparties, and the Act's influence on global platform and product design.",why:"Organizations with digital asset exposure operating internationally face MiCA compliance obligations whether or not they are EU-based. Understanding the framework is prerequisite to advising on digital asset strategy.",action:"Identify any business units, vendors, or counterparties with digital asset exposure \u2014 through products, payment systems, or investments. For each, determine whether MiCA applies directly or is transmitted through counterparty or vendor relationships. Indirect exposure is still exposure.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Smart Contracts in Court: 2025 Case Law",source:"Sideman & Bancroft \u00b7 Smart Contracts Revisited: Lessons from the Courts (2025)",insight:"Recent US case law is clarifying the boundaries of smart contract enforceability. The Fifth Circuit's Van Loon v. Department of the Treasury (2024) ruled that immutable smart contracts themselves are not property under OFAC sanctions law, but associated infrastructure can be sanctioned. Separately, courts have begun treating unincorporated DAOs as general partnerships, exposing token-holding members to personal liability. Smart contracts execute automatically — but they do not operate outside legal and regulatory frameworks.",why:"Automatic execution creates an illusion of legal finality that courts are actively contradicting. Any organization deploying smart contracts for consequential transactions needs a governance framework that addresses jurisdiction, dispute resolution, and liability allocation — before the contract executes, not after.",action:"For any smart contract deployment your organization is evaluating or has made, verify two things: what jurisdiction governs the agreement, and what is the recourse mechanism if the contract executes contrary to intent? These are governance questions that must be answered before deployment.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"How Verifiable Credentials Work",source:"W3C \u00b7 Verifiable Credentials Data Model 2.0 (May 2025)",insight:"Verifiable Credentials are cryptographically signed digital statements \u2014 the digital equivalent of a diploma or professional license. The trust model has three roles: Issuer (a trusted authority that signs the credential), Holder (the individual or organization that receives and presents it), and Verifier (the party that checks its validity without contacting the issuer). The W3C standard became a formal Recommendation in May 2025 and underlies EU eIDAS 2.0 digital wallets.",why:"Digital credentials are replacing paper-based identity verification in regulated industries. Professionals advising on digital identity, professional licensing, and cross-border transactions need to understand the architecture.",action:"Identify one credential your organization issues or relies on — an employee certification, a vendor qualification, or a regulatory compliance attestation.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"Token Architecture: Five Views",source:"NIST \u00b7 IR 8301 \u2014 Blockchain Networks: Token Design and Management",insight:"NIST\'s framework for understanding token systems organizes complexity into five views: token view (what the token represents and its properties), wallet view (how tokens are held), transaction view (how transfers are authorized), user interface view (how participants interact), and protocol view (consensus mechanisms and network architecture). This framework lets you evaluate any tokenization proposal systematically rather than getting lost in vendor-specific terminology.",why:"Organizations presenting tokenization proposals use vendor terminology that obscures rather than clarifies. The five-view framework gives you an evaluation structure that cuts through the language.",action:"Request that any vendor presenting a tokenization proposal structure their presentation around NIST\'s five views. The ones who can do it understand their system. The ones who can\'t are selling a concept, not a solution.",cat:"blockchain",pillar:"Blockchain & Digital Trust"},
  {title:"The CISO-CEO Perception Gap",source:"World Economic Forum \u00b7 Global Cybersecurity Outlook 2025",insight:"The WEF Global Cybersecurity Outlook 2025 documents a persistent gap: CISOs consistently rate their organizations as less secure than CEOs do. This is not a communication problem \u2014 it is a structural one. CEOs have strategic proximity to cybersecurity spending decisions but operational distance from actual risk. The gap widens where CISOs report to the CIO rather than directly to leadership, limiting visibility. Organizations with the smallest perception gap have the best security outcomes.",why:"Senior executives consistently overestimate their organization's security posture relative to their security teams' assessments. That gap is where breaches originate and where insurance claims get denied.",action:"Ask your IT lead or security person: on a scale of 1\u201310, how prepared are we for a serious breach? Then answer independently. If your answers differ by more than two points, the perception gap is real \u2014 and it needs a governance solution, not a meeting.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Breach Cost in Business Terms",source:"Ponemon/IBM \u00b7 Cost of a Data Breach Report 2024",insight:"The IBM/Ponemon Cost of a Data Breach Report analyzes 600+ organizations across 16 countries annually. 2024 findings: global average breach cost is $4.88M, up 10% from 2023. Mean time to identify: 194 days. Mean time to contain: 64 days. Organizations using AI and automation in security operations saved an average of $2.22M per breach. Organizations with tested incident response plans saved $1.49M. These are financial inputs for a legitimate security investment calculation.",why:"Executive leaders respond to risk expressed in financial terms. The cost-of-breach data translates cybersecurity from a technical concern to a business decision with quantifiable stakes.",action:"Calculate a rough expected annual loss: estimate your probability of a breach this year, multiply by the $4.88M average adjusted for your organization's size and industry. Compare that to your current security budget. The math is usually instructive.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"What Threats Are Actually Hitting Firms",source:"Verizon \u00b7 Data Breach Investigations Report 2024",insight:"The Verizon DBIR analyzes thousands of confirmed breaches annually. 2024 findings: 68% of breaches involved a human element \u2014 phishing, stolen credentials, social engineering. 32% involved ransomware or extortion, nearly double the prior year. Financially motivated attacks account for 92% of incidents. The median time for a user to click a phishing email is under 60 seconds. Vendor threat narratives differ substantially from this empirical data.",why:"Organizations are high-value targets because of the operational and customer data they hold, the financial transactions they process, and the access they provide to partner systems. The DBIR data tells you what is actually hitting firms like yours \u2014 not what vendors are selling solutions for.",action:"Share the three DBIR findings with your leadership team. Ask: which of these three threat vectors is our organization most exposed to? Start there, not with the vendor\\'s preferred narrative.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"The Cyber Hygiene Baseline",source:"CIS Controls v8.1 \u00b7 Implementation Group 1 / CISA Cybersecurity Performance Goals",insight:"The Center for Internet Security\\'s Implementation Group 1 defines 56 essential cybersecurity safeguards for every organization regardless of size: asset inventory, software inventory, data protection basics, secure configuration, account management, access control, vulnerability management, audit log management, email and browser protections, and malware defense. An organization that achieves IG1 eliminates the vast majority of common attack vectors. CISA\\'s Performance Goals map these to a prioritized action list.",why:"Most organization breaches exploit the absence of basic controls, not sophisticated vulnerabilities. IG1 is the minimum standard \u2014 and most firms have not achieved it.",action:"Download the CIS Controls IG1 safeguard list. Score your organization against each: implemented, partially implemented, or not implemented. Any \\'not implemented\\' is an open door.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Quantifying Cyber Risk in Dollars",source:"FAIR Institute \u00b7 Factor Analysis of Information Risk",insight:"Heat maps with red/yellow/green ratings look like risk management but measure nothing. FAIR (Factor Analysis of Information Risk) is the open standard for expressing cyber risk as a range of probable financial loss. FAIR analysis requires two inputs: likelihood of a loss event in a given period, and the probable magnitude of loss if it occurs. The output is a financial range that can be compared against insurance coverage, controls investment, and risk appetite. Boards and CFOs respond to financial risk language, not color charts.",why:"Executive leaders who present cyber risk in financial terms get better board engagement and better budget decisions than those who present heat maps.",action:"Identify one cyber risk currently on your risk register or in your board reporting. Attempt a FAIR analysis: estimate occurrence probability (per year) and probable financial impact (low/high range). The process reveals the data gaps more than it produces an immediate answer.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Integrating Cyber into Enterprise Risk",source:"NIST \u00b7 IR 8286 Series \u2014 Cybersecurity and Enterprise Risk Management",insight:"The NIST IR 8286 series, updated December 2025 to align with CSF 2.0, provides the methodology for integrating cybersecurity risk into the enterprise risk management portfolio. It bridges the most common structural failure: cybersecurity sitting in a silo from ERM, using different language, measurement approaches, and escalation paths. The 8286 series connects CISO operations to leadership risk oversight through a unified risk register and shared taxonomy.",why:"Cyber risk that lives only in IT is invisible to the organization's enterprise risk governance structure. When a breach occurs, leadership is caught unprepared because the risk was never on the register they review.",action:"Ask your risk management and IT security leadership: do they use the same risk register and express risk in the same financial language? If not, you have a structural governance gap. The NIST IR 8286 series provides the integration architecture.",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Secure by Design: The Vendor Lens",source:"CISA \u00b7 Secure by Design Principles",insight:"CISA\\'s Secure by Design initiative calls on technology manufacturers to eliminate vulnerability classes at the design level rather than pushing security configuration burden onto customers. The three core principles: take ownership of customer security outcomes, embrace radical transparency, build organizational structures that prioritize security. Over 260 vendors have signed the voluntary pledge. The framework gives buyers a structured way to evaluate vendor security claims beyond marketing language.",why:"Technology vendors make aggressive security claims that are difficult to evaluate without a structured framework. Secure by Design provides that framework — built on federal principles rather than marketing language.",action:"Apply Secure by Design to your next technology procurement. Ask: what security is on by default? What does the customer have to configure to be secure? What is your published vulnerability disclosure policy?",cat:"cybersecurity",pillar:"Cybersecurity"},
  {title:"Why Organizations Fail at Data",source:"Harvard Business Review \u00b7 Companies Are Failing to Become Data-Driven (Bean, 2019)",insight:"The HBR survey that launched a decade of follow-up research: despite massive investment in data infrastructure, most organizations fail to achieve data-driven transformation. The primary barrier is not technology. It is organizational culture, management behavior, and the absence of a data strategy connected to business outcomes. Leaders who believe they have a data problem usually have a leadership problem.",why:"Organizations have invested in data warehouses, BI platforms, and analytics tools for years without becoming genuinely data-driven. The constraint is almost never the technology — it is leadership behavior and the willingness to act on analysis that contradicts intuition.",action:"In your next significant organizational decision, explicitly state what data informed your conclusion. Make your reasoning visible. Data culture is built by leaders who model data-informed decision-making.",cat:"data",pillar:"Data & Analytics"},
  {title:"The Analytics Maturity Ladder",source:"MIT Sloan \u00b7 AI & Data Leadership Benchmark (Davenport & Bean, 2025)",insight:"Analytics capability exists on a maturity ladder: Descriptive (what happened?), Diagnostic (why did it happen?), Predictive (what will happen?), Prescriptive (what should we do?). Most organizations operate at descriptive level \u2014 generating reports that tell leaders what already occurred. Competitive advantage lives at predictive and prescriptive levels, where data informs future decisions and optimizes choices in real time. Investment without architecture change does not advance maturity.",why:"The firms moving fastest on AI adoption have already built analytical maturity that gives AI systems quality data to work with. Firms at descriptive maturity will find AI amplifies the limitations of their data.",action:"Identify your organization's most-used analytics output. Is it descriptive, diagnostic, predictive, or prescriptive? What would it take to move it one level up the maturity ladder?",cat:"data",pillar:"Data & Analytics"},
  {title:"What a Chief Data Officer Actually Does",source:"MIT Sloan Management Review \u00b7 The CDO Role: What\\'s Next / Deloitte CDO Survey 2025",insight:"84% of large organizations now have a CDO, yet more than half serve fewer than three years. MIT Sloan\\'s analysis identifies the tension: CDOs are expected to govern data (conservative, compliance-oriented) while simultaneously enabling AI (aggressive, experimental). The Deloitte CDO Survey 2025 finds governance is the top CDO priority (51%), yet organizational culture is the most significant adoption barrier (69%). The CDO role is expanding and failing simultaneously.",why:"Organizations appointing technology or data leadership need to understand this tension. CDOs who are measured only on governance metrics are budget reduction targets. Those connected to business value creation are strategic assets.",action:"If your organization has a CDO or equivalent, evaluate their mandate. Are they accountable for governance, enablement, or both? If both, are those objectives funded and sequenced appropriately \u2014 or are they competing for the same resources?",cat:"data",pillar:"Data & Analytics"},
  {title:"Proprietary Data as Competitive Advantage",source:"McKinsey \u00b7 Path to the Data- and AI-Driven Enterprise of 2030",insight:"Every AI model can access the same publicly available training data. What differentiates an organization\\'s AI capability is the proprietary data only it possesses: customer interaction patterns, operational outcome data, pricing history, and accumulated institutional knowledge. McKinsey describes this as \\'competitive alpha\\' from proprietary data \u2014 the strategic moat that public AI systems cannot replicate. Organizations with curated, governed proprietary data will build AI capabilities competitors cannot copy.",why:"Your organization's accumulated project data, customer communications, and outcome records are a strategic asset. Ungoverned, they are a liability. Curated, they are the foundation of a durable AI advantage.",action:"Identify three data sets your organization possesses that competitors do not. For each, ask: is this data currently clean, catalogued, and accessible for AI use? If not, that is your data infrastructure priority.",cat:"data",pillar:"Data & Analytics"},
  {title:"Ethics in Algorithmic Decision-Making",source:"Stanford HAI \u00b7 AI Policy Research / WEF Data Equity for Generative AI",insight:"Algorithmic systems that make or influence decisions about people \u2014 hiring, credit, sentencing, benefits \u2014 carry fairness and accountability obligations increasingly embedded in law. The EU AI Act classifies such systems as high risk, requiring conformity assessments. The WEF\\'s Data Equity framework adds a dimension most technical teams overlook: representation in training data. Systems trained on historically biased data reproduce and amplify historical bias.",why:"Professionals advising clients deploying AI in consequential decisions \u2014 employment screening, loan underwriting, healthcare \u2014 need to understand the fairness and accountability obligations those systems carry.",action:"Identify any AI system your organization deploys that influences decisions about people. Ask: can the decision be explained to the affected person? Has the system been tested for differential impact across demographic groups? Is there a human review process for contested decisions?",cat:"data",pillar:"Data & Analytics"},
  {title:"Unstructured Data: The Unlocked Asset",source:"McKinsey \u00b7 Path to the AI-Driven Enterprise of 2030",insight:"Approximately 80% of enterprise data is unstructured \u2014 emails, documents, contracts, meeting notes, recorded calls, and customer communications. Traditional analytics ignores this because it cannot be put in a spreadsheet. Generative AI changes the equation: large language models can process unstructured text, extract structure, and reason about it at scale. Organizations hold enormous volumes of unstructured data in documents and communications that AI can now unlock.",why:"The organizations that will build the most powerful AI capabilities are those that can unlock their unstructured document and operational history. This is both a data architecture challenge and a governance challenge.",action:"Estimate what percentage of your organization's institutional knowledge exists only in unstructured formats. What would it mean for your AI capability if that knowledge were searchable and accessible? What is currently preventing it?",cat:"data",pillar:"Data & Analytics"},
  {title:"The Conscious Competence Map",source:"The AV Studio \u00b7 Coaching Methodology / Gordon Training International",insight:"The Conscious Competence model identifies four stages of learning: Unconscious Incompetence (you don\\'t know what you don\\'t know), Conscious Incompetence (you know you don\\'t know, and it\\'s uncomfortable), Conscious Competence (you can do it with deliberate effort), and Unconscious Competence (mastery \u2014 it happens automatically). Most executives navigating technology transformation are at stage two: they have learned enough to know how much they don\\'t know. That is not a deficit. It is the most important stage \u2014 where learning accelerates.",why:"Self-awareness about competence stage is the prerequisite to productive learning. Executives who believe they are at stage three when they are at stage one are the most dangerous technology decision-makers.",action:"Apply this model to one technology domain directly relevant to your role and your organization's strategy. Be specific about your current stage. Write down one action that would move you from where you are toward the next stage.",cat:"governance",pillar:"Governance & Risk"},
  {title:"The Hype Cycle as Investment Filter",source:"Gartner \u00b7 Hype Cycle Methodology",insight:"Gartner\\'s Hype Cycle tracks technologies through five phases: Innovation Trigger, Peak of Inflated Expectations, Trough of Disillusionment, Slope of Enlightenment, and Plateau of Productivity. Executives who invest at the Peak overpay and accept early-adopter risk. Those who invest on the Slope capture value without the speculative premium. Generative AI broadly is at or near the Peak of Inflated Expectations. Enterprise-specific applications — industry workflow automation, specialized AI agents, vertical AI platforms — are earlier in the cycle and represent the more durable investment opportunity.",why:"Technology investment decisions made at the Peak of Inflated Expectations consistently underdeliver on projected returns. Understanding where a technology sits on the cycle is as important as understanding the technology itself.",action:"Place three technologies on your current investment agenda on the Hype Cycle. For those at the Peak, ask: are we investing for competitive advantage or to avoid missing out? Those are different decisions with different return profiles.",cat:"governance",pillar:"Governance & Risk"},
  {title:"ISO 31000: The Universal Risk Language",source:"ISO 31000:2018 \u00b7 Risk Management Guidelines",insight:"ISO 31000 is the international standard for risk management applicable to any type of risk across any organization. Its core process: establish context, identify risks, analyze risks (likelihood and consequence), evaluate against risk appetite, treat risks, monitor and review, communicate and consult. Understanding ISO 31000 ensures that technology risk discussions connect to enterprise risk management rather than operating as a parallel function. It is the common language between technology leaders and boards.",why:"Leadership teams that speak ISO 31000 language when presenting technology risk get better board engagement and better decisions than those presenting technology-specific frameworks that leadership doesn\\'t recognize.",action:"Identify the last technology risk you presented to leadership or the board. Did it follow the ISO 31000 process \u2014 context, likelihood, consequence, treatment options? If not, rebuild it in that format and compare the reception.",cat:"governance",pillar:"Governance & Risk"},
  {title:"The AI Risk Framework in Practice",source:"NIST \u00b7 AI RMF Playbook",insight:"The NIST AI RMF Playbook translates the four AI RMF functions into specific suggested actions: Govern (establish policies and accountability structures), Map (categorize AI systems by risk and context), Measure (analyze and assess identified risks), Manage (prioritize and implement risk treatments). Most organizations implement Map and Measure. Far fewer implement Govern and Manage consistently \u2014 which is why identified risks often remain untreated. The Playbook is updated twice per year and is free.",why:"Regulators, auditors, and enterprise customers increasingly treat NIST AI RMF compliance as the baseline expectation for responsible AI deployment. Organizations that use the Playbook operationally \u2014 not just as a reference document — build demonstrable governance postures that satisfy those expectations.",action:"Download the NIST AI RMF Playbook. Evaluate your organization against all four functions. Govern and Manage are almost always the gaps \u2014 and they are the functions that determine whether identified risks are actually addressed.",cat:"governance",pillar:"Governance & Risk"},
  {title:"The Board\\'s Cyber Governance Obligations",source:"NACD \u00b7 Director\\'s Handbook on Cyber-Risk Oversight / WEF Principles for Board Governance",insight:"The NACD/ISA Director\\'s Handbook establishes six principles for board-level cybersecurity governance: understand cybersecurity as a strategic enterprise risk, understand the legal implications, ensure adequate expertise access, establish board-level oversight processes, incorporate cybersecurity into ERM, and engage on systemic resilience. These principles were developed with CISA and the FBI. Boards operating without them face regulatory and liability exposure.",why:"Whether you sit on a board or report to one, the six NACD principles define what rigorous cybersecurity governance looks like at the oversight level. Organizations whose boards operate without them carry governance gaps visible to regulators, auditors, and insurers. ",action:"Review the six NACD principles against your organization's current governance practices. Which principle receives the least attention? That gap is both a governance risk and a potential liability exposure.",cat:"governance",pillar:"Governance & Risk"},
  {title:"Data Privacy: The Regulatory Stack",source:"GDPR / CCPA-CPRA / NIST Privacy Framework",insight:"Organizations handling personal data navigate a layered regulatory environment: GDPR (EU \u2014 extraterritorial reach to any organization processing EU residents\\' data, penalties up to 4% of global annual revenue), CCPA/CPRA (California \u2014 $7,500 per intentional violation, a model for other states), and the NIST Privacy Framework (the US government\\'s voluntary operationalization tool). These are not independent frameworks \u2014 they interact and sometimes conflict.",why:"Organizations with California customers, EU counterparties, or any multinational operations carry multi-jurisdictional privacy obligations. A single-jurisdiction compliance approach consistently underestimates exposure.",action:"Map your organization's data processing activities against GDPR, CCPA, and NIST Privacy Framework requirements. Identify where activities trigger obligations under more than one framework. Those intersections are your highest compliance risk.",cat:"governance",pillar:"Governance & Risk"},
  {title:"The CSF 2.0 Six Functions",source:"NIST \u00b7 Cybersecurity Framework 2.0 (2024)",insight:"NIST CSF 2.0 added Govern as a sixth function to the original five (Identify, Protect, Detect, Respond, Recover). The addition is deliberate: it elevates cybersecurity governance to an executive and board-level responsibility. The Govern function covers establishing cybersecurity strategy, policy, roles, and accountability structures. Organizations with executive-level accountability for cybersecurity outcomes dramatically outperform those that delegate entirely to technical teams.",why:"The executive leader who understands the six CSF functions can drive a governance conversation with their IT team, their board, and their insurance underwriter. It is the common framework all three parties use.",action:"Assess which of the six CSF functions is least mature in your organization. Note that Govern is most often the weakest in organizations without a formal security governance structure. That is your starting point.",cat:"governance",pillar:"Governance & Risk"},
  {title:"The EU AI Act Risk Tiers",source:"European Commission \u00b7 EU AI Act (entered into force August 2024)",insight:"The EU AI Act classifies AI systems into four risk tiers: Unacceptable risk (prohibited \u2014 social scoring, real-time biometric surveillance), High risk (mandatory requirements \u2014 AI in hiring, credit, education, healthcare, legal outcomes), Limited risk (transparency obligations \u2014 chatbots, deepfakes), and Minimal risk (most current applications). High-risk systems require conformity assessments, risk management systems, and human oversight mechanisms.",why:"Even US-only organizations encounter the EU AI Act through vendors, multinational clients, and the Act\\'s influence on global AI product design. Advising on AI governance without understanding the EU framework is incomplete.",action:"Inventory your organization's AI systems and classify each against the four EU AI Act risk tiers. Any system in the high-risk category requires governance controls \u2014 whether or not you operate in the EU.",cat:"governance",pillar:"Governance & Risk"},
  {title:"NIST CSF Organizational Profile as Management Tool",source:"NIST \u00b7 CSF 2.0 Organizational Profile Template",insight:"The NIST CSF Organizational Profile is a structured self-assessment capturing a Current Profile (where your organization is across all six CSF functions) and a Target Profile (where you need to be, driven by risk appetite and business requirements). The gap between current and target becomes your prioritized security roadmap \u2014 grounded in your specific context, not generic vendor recommendations. The template is free and designed for organizations of any size.",why:"Organizations without a structured security roadmap make technology decisions reactively. The CSF Organizational Profile converts reactive decision-making into a managed program \u2014 and produces documentation that satisfies underwriters, regulators, and client due diligence requests.",action:"Download the NIST CSF Organizational Profile template. Assemble your IT, security, and risk leadership to complete a current profile for one CSF function this month. The discipline of the exercise is as valuable as the output.",cat:"governance",pillar:"Governance & Risk"},
  {title:"What Technology Leadership Actually Is",source:"McKinsey \u00b7 Rewired: The Guide to Outcompeting in the Age of Digital and AI",insight:"Technology leadership is not managing IT. It is leading transformation \u2014 a fundamentally different mandate. Managing IT optimizes existing systems. Leading transformation redesigns how work is done, how value is created, and how the organization learns. McKinsey\\'s research on 200+ at-scale digital transformations finds that organizations succeeding treat technology leadership as a core executive responsibility distributed across leadership \u2014 not delegated entirely to an IT function.",why:"Executive leaders who treat technology as an IT department responsibility will consistently lag those who treat it as a leadership function. The organizations leading on AI are led by executives who engage directly with technology decisions.",action:"Identify one technology decision made last month that affected your practice that you delegated entirely to IT or outside counsel. Reclaim that judgment. Technology decisions that affect your domain require your direct engagement.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"The Influence Model for Tech Change",source:"McKinsey \u00b7 The Influence Model for Organizational Change",insight:"McKinsey\\'s Influence Model identifies four conditions required to change organizational behavior: role modeling (leaders must demonstrate the change themselves), fostering understanding and conviction (people need to understand why the change matters), reinforcing with formal mechanisms (incentives and structures must align), and developing talent and skills (people need capability, not just direction). Technology transformations that fail typically fail on condition one: leaders asking others to change while continuing to work the same way.",why:"Executive leaders who ask professionals to adopt AI tools while continuing to work manually send an unmistakable signal. The adoption rate of any technology in a firm reflects the executive leader\\'s visible behavior first.",action:"Apply the four-condition test to one technology change you are currently leading. Which condition is weakest? For most leaders it is condition one. What would it look like for you to personally model the behavior you are asking of others?",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Why Culture Beats Technology",source:"McKinsey / Harvard Business Review \u00b7 Digital Transformation Research",insight:"Every major research stream on digital transformation \u2014 McKinsey, MIT Sloan, HBR, Deloitte \u2014 arrives at the same finding: culture is the primary determinant of transformation success or failure, not technology. Organizations with healthy learning cultures and clear accountability succeed with average technology. Organizations with change-resistant cultures fail with world-class technology. This is not an argument against technology investment \u2014 it is an argument for sequencing: address culture before scaling technology.",why:"Organizations that invest in AI tools without addressing the cultural conditions for adoption \u2014 psychological safety, learning orientation, leadership accountability \u2014 systematically underperform their technology investment.",action:"Rate your organization's culture on three dimensions: learning orientation (do we analyze failures without blame?), risk tolerance (are people penalized for trying and failing?), and leadership accountability (are leaders held accountable for transformation outcomes?). Low scores on any dimension are technology inhibitors.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"The Six Capabilities of Digital Winners",source:"McKinsey \u00b7 Rewired: Six Capabilities of Successful Transformations",insight:"McKinsey\\'s analysis of 200+ at-scale digital transformations identifies six capabilities distinguishing successful organizations: a clear technology strategy connected to business strategy, a talent model that develops technology-fluent leaders, an operating model embedding technology in business units rather than centralizing it in IT, a technology architecture enabling speed and flexibility, a data foundation making information trustworthy and accessible, and a systematic adoption model scaling proven approaches. Organizations building all six consistently outperform those excelling in two or three.",why:"Most organizations invest in one or two of these capabilities \u2014 usually technology and data \u2014 while neglecting strategy alignment, talent development, and adoption systems. The weakest capability disproportionately constrains the entire system.",action:"Rate your organization on all six capabilities (1\u20135). Your two lowest scores are where the leverage is. Address those before increasing investment in dimensions where you are already strong.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Leading Through Technology Anxiety",source:"Harvard Business Review \u00b7 Leading Digital Transformation / The AV Studio",insight:"Technology anxiety in senior leaders is not a knowledge deficit. It is a threat response \u2014 the fear of appearing incompetent in front of peers, direct reports, and board members, of making decisions in a domain where experience no longer provides reliable guidance. The leaders who manage it best do three things: they name the anxiety honestly rather than masking it with false confidence, they create psychological safety for their teams to surface what they don\\'t know, and they invest in deliberate learning rather than waiting for the discomfort to resolve on its own.",why:"Executive leaders who mask technology anxiety with false confidence make worse technology decisions and suppress the honest conversations their teams need to have. Naming it is both a leadership act and a governance improvement.",action:"Identify one technology domain where you feel the most uncertainty. Name that uncertainty to a direct report or peer this week. The act of naming it reduces its power and models the psychological safety that technology transformation requires.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"Technology Decisions Under Uncertainty",source:"Harvard Business Review \u00b7 Decision Frameworks / Gartner",insight:"Technology decisions are categorically different from operational decisions because many are irreversible: architecture choices, platform selections, and vendor relationships are costly or impossible to undo. The two-door framework applies: Type 1 decisions (irreversible) require more deliberation, more data, and explicit risk assessment. Type 2 decisions (reversible) should be made quickly and iterated. Most technology executives apply the same process to both categories \u2014 moving too slowly on reversible decisions or too quickly on irreversible ones.",why:"The AI platform your organization commits to, the data architecture you standardize on, the core platform vendor you build around \u2014 these are Type 1 decisions. Treating them with Type 2 speed creates compounding costs.",action:"Categorize your three most recent significant technology decisions: Type 1 (irreversible) or Type 2 (reversible). Did your decision process match the category? For any Type 1 decision made with Type 2 speed, document the risk you accepted.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"The 2030 Organization",source:"McKinsey \u00b7 The Agentic Organization / WEF Future of Jobs 2025",insight:"McKinsey and WEF research describes the 2030 organization: AI agents handle multi-step operational work that currently requires human coordination; human roles concentrate in judgment, creativity, relationship management, and exception handling; organizational structures flatten as AI removes the information-processing justification for managerial layers; 170 million new roles emerge that do not currently exist. Organizations planning backward from this vision are redesigning work and building AI infrastructure now.",why:"The leaders who will lead their organizations in 2030 are the ones engaging seriously with AI today \u2014 not reacting to each quarterly AI news cycle, but building deliberate capability and organizational design with a five-year horizon.",action:"Sketch what your organization looks like in 2030 if AI agents are embedded in your core operations. What roles exist that don\\'t today? What roles are gone or transformed? Use that sketch as a planning document, not a prediction.",cat:"techleadership",pillar:"Technology Leadership"},
  {title:"The Federal Data Strategy as Blueprint",source:"US Federal Data Strategy \u00b7 2020 Action Plan and Principles",insight:"The US Federal Data Strategy\\'s three overarching principles \u2014 ethical governance, conscious design, and learning culture \u2014 provide a framework that extends directly to private sector organizations. Ethical governance means data practices are accountable and rights-respecting. Conscious design means data systems are built intentionally rather than accumulating accidentally. Learning culture means continuous capability improvement rather than treating data transformation as a one-time project.",why:"Organizations building data programs for the first time benefit from a principled framework that is not vendor-defined. The Federal Data Strategy is the most rigorous publicly available baseline for organizational data governance design.",action:"Rate your organization against the three principles: ethical governance (1\u20135), conscious design (1\u20135), learning culture (1\u20135). The lowest score is your strategic priority for the next 90 days.",cat:"data",pillar:"Data & Analytics"},
  {title:"The Global AI Policy Landscape",source:"OECD \u00b7 AI Policy Observatory / Stanford HAI Policy Research",insight:"The OECD AI Policy Observatory tracks 900+ AI policy initiatives from 70+ countries. The pattern is clear: AI regulation is accelerating globally. The EU AI Act is most comprehensive; China\\'s regulations are most prescriptive; the US federal approach remains fragmented between executive orders and sectoral guidance. Stanford HAI\\'s policy research provides academic analysis of which regulatory approaches are effective and which create compliance burden without safety benefit.",why:"Clients operating across jurisdictions face AI regulatory requirements that vary significantly. Professionals who track the global landscape can provide more strategic compliance guidance than those reacting to one jurisdiction at a time.",action:"Identify the three jurisdictions most relevant to your organization's operations or target markets. Research the current AI regulatory posture of each. Assign someone on your team to monitor regulatory developments in those jurisdictions quarterly.",cat:"governance",pillar:"Governance & Risk"},
  {title:"The Practice Embodies the Model",source:"The AV Studio \u00b7 Coaching Practice Design",insight:"The most powerful demonstration of technology leadership competence is not a presentation or a credential. It is how you operate. An executive who uses AI tools deliberately and transparently, who makes decisions grounded in data while applying professional judgment, who governs technology risk seriously, and who continuously develops technology fluency demonstrates the model. In coaching and leadership, credibility comes from embodying the principles you advocate. The gap between what leaders say about technology and how they actually engage with it is visible to every person they lead.",why:"Clients choose advisors they believe understand the terrain they\\'re navigating. An executive who can speak credibly from personal technology experience \u2014 not just about it \u2014 builds a different quality of trust.",action:"Identify the largest gap between your stated technology leadership principles and your actual daily practice. Name it. Address it this week. The leaders who practice what they teach are the ones worth following.",cat:"techleadership",pillar:"Technology Leadership"},,,
];

const QUOTES = [
  {text:"Trustworthy AI requires transparency, accountability, and a commitment to human oversight.",source:"NIST · AI RMF 1.0"},
  {text:"AI governance is not a technology problem. It is a leadership problem.",source:"Deloitte · Board AI Oversight 2025"},
  {text:"The question is not whether AI will affect your practice. The question is whether you will lead that change.",source:"McKinsey Global Institute"},
  {text:"Competence requires more than technical proficiency — it requires understanding the tools you deploy.",source:"ABA · Formal Opinion 512"},
  {text:"Organizations that treat data as a strategic asset consistently outperform those that treat it as a byproduct.",source:"Davenport & Bean · 2025 Benchmark"},
  {text:"Zero trust is not a product. It is an architecture — and a mindset.",source:"CISA · Zero Trust Maturity Model"},
  {text:"The board that does not understand AI cannot govern its risks.",source:"Deloitte · Board Practices Report"},
  {text:"Digital identity is the perimeter. Everything else follows from it.",source:"NIST · SP 800-63"},
  {text:"Privacy is not a compliance checkbox. It is a design principle.",source:"IAPP"},
  {text:"Leaders who stop learning about technology become dependent on those who may not share their interests.",source:"MIT Sloan Management Review"},
  {text:"The firms that will thrive are those whose leaders understand technology well enough to ask the right questions.",source:"Thomson Reuters · Law Firm Financial Performance Report 2025"},
  {text:"Accountability for AI outcomes must sit with people, not systems.",source:"OECD · AI Principles"},
];

function getCatStyle(c) {
  const m = {
    ai:{color:C.ai,label:"AI & Automation"},
    blockchain:{color:C.bc,label:"Blockchain & Digital Trust"},
    cybersecurity:{color:C.cy,label:"Cybersecurity"},
    data:{color:C.ds,label:"Data & Analytics"},
    governance:{color:C.gov,label:"Governance & Risk"},
    techleadership:{color:C.tl,label:"Technology Leadership"},
  };
  return m[c] || m.ai;
}

const todayStr = () => new Date().toISOString().split("T")[0];
const dse = () => Math.floor(Date.now() / 86400000);
const defaultData = () => ({ completed: [], streak: { count: 0, last: "" }, bookmarks: [], journal: {} });

function LessonCard({ l, idx, onClick, isDone, cs }) {
  return (
    <button onClick={onClick} style={{ background: C.bg2, borderRadius: 14, border: "1px solid " + C.border, width: "100%", textAlign: "left", padding: "14px 16px", marginBottom: 4, opacity: isDone ? 0.5 : 1, fontFamily: fb, cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: isDone ? C.textDim : cs.color, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: fh, fontSize: 13, fontWeight: 600, color: isDone ? C.textDim : C.white }}>{l.title}</div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{l.source}</div>
        </div>
        {isDone && <span style={{ fontSize: 10, color: C.cy }}>✓</span>}
      </div>
    </button>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [screen, setScreen] = useState("loading");
  const [sel, setSel] = useState(null);
  const [filter, setFilter] = useState("all");
  const [sq, setSq] = useState("");
  const [jt, setJt] = useState("");
  const [tab, setTab] = useState("home");

  useEffect(() => {
    (async () => {
      try {
        await initTeams();           // initialise Teams SDK + Graph token (no-op outside Teams)
        const raw = await storageLayer.get();
        if (raw) { setData(JSON.parse(raw)); } else { setData(defaultData()); }
      } catch (e) { setData(defaultData()); }
      setScreen("home");
    })();
  }, []);

  const save = useCallback(async (d) => {
    setData(d);
    try { await storageLayer.set(JSON.stringify(d)); } catch (e) {}
  }, []);

  const comp = data ? data.completed || [] : [];
  const bm = data ? data.bookmarks || [] : [];
  const stk = data ? data.streak || { count: 0, last: "" } : { count: 0, last: "" };
  const jnl = data ? data.journal || {} : {};
  const ti = dse() % LESSONS.length;
  const tl = LESSONS[ti];
  const todayDone = comp.indexOf(ti) !== -1;
  const dq = QUOTES[dse() % QUOTES.length];

  const doComplete = (i) => {
    if (comp.indexOf(i) !== -1) return;
    const nc = [...comp, i];
    const t = todayStr();
    const y = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const ns = stk.last === t ? stk.count : (stk.last === y ? stk.count + 1 : 1);
    save({ ...data, completed: nc, streak: { count: ns, last: t } });
  };

  const toggleBm = (i) => {
    const nb = bm.indexOf(i) !== -1 ? bm.filter(b => b !== i) : [...bm, i];
    save({ ...data, bookmarks: nb });
  };

  const saveJ = (i, txt) => {
    const nj = { ...jnl, [i]: { text: txt, date: todayStr() } };
    save({ ...data, journal: nj });
  };

  // Group by institution (first part of source before "·")
  const srcMap = useMemo(() => {
    const m = {};
    LESSONS.forEach((l, i) => {
      const inst = l.source.split("·")[0].trim();
      if (!m[inst]) m[inst] = { docs: {}, idx: [] };
      m[inst].idx.push(i);
      const doc = l.source.split("·")[1]?.trim() || l.source;
      m[inst].docs[doc] = true;
    });
    return m;
  }, []);

  const srcList = useMemo(() => Object.keys(srcMap).sort((a, b) => srcMap[b].idx.length - srcMap[a].idx.length), [srcMap]);
  const cats = ["all","ai","blockchain","cybersecurity","data","governance","techleadership"];

  const fLessons = useMemo(() => {
    if (sq.trim()) {
      const q = sq.toLowerCase();
      return LESSONS.filter(l => l.title.toLowerCase().includes(q) || l.source.toLowerCase().includes(q) || l.insight.toLowerCase().includes(q));
    }
    return filter === "all" ? LESSONS : LESSONS.filter(l => l.cat === filter);
  }, [filter, sq]);

  const crd = { background: C.bg2, borderRadius: 14, border: "1px solid " + C.border };
  const btnS = { fontFamily: fb, border: "none", cursor: "pointer" };
  const goLesson = (i) => { setSel(i); setScreen("lesson"); setJt(""); window.scrollTo(0, 0); };

  const Nav = () => (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.bg2, borderTop: "1px solid " + C.border, display: "flex", justifyContent: "center", zIndex: 100 }}>
      <div style={{ display: "flex", maxWidth: 540, width: "100%", justifyContent: "space-around" }}>
        {[{id:"home",icon:"◉",label:"Today"},{id:"library",icon:"▤",label:"Library"},{id:"sources",icon:"◎",label:"Sources"},{id:"stats",icon:"◆",label:"Progress"}].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setScreen("home"); setSel(null); window.scrollTo(0,0); }} style={{ ...btnS, flex: 1, padding: "10px 0 8px", textAlign: "center", background: "transparent", color: tab === t.id ? C.gold : C.textMut }}>
            <div style={{ fontSize: 18 }}>{t.icon}</div>
            <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2 }}>{t.label}</div>
          </button>
        ))}
      </div>
    </div>
  );

  if (screen === "loading") return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{FCSS}</style>
      <p style={{ color: C.textDim, fontFamily: fb }}>Loading...</p>
    </div>
  );

  // LESSON DETAIL
  if (screen === "lesson" && sel !== null) {
    const l = LESSONS[sel];
    const cs = getCatStyle(l.cat);
    const dn = comp.indexOf(sel) !== -1;
    const bkd = bm.indexOf(sel) !== -1;
    const je = jnl[sel];
    return (
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: fb, maxWidth: 540, margin: "0 auto", paddingBottom: 40 }}>
        <style>{FCSS}</style>
        <div style={{ padding: "20px 20px 40px" }}>
          <button onClick={() => { setScreen("home"); setSel(null); setJt(""); }} style={{ ...btnS, fontSize: 13, color: C.gold, background: "transparent", marginBottom: 16, padding: 0 }}>← Back</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <img src={LOGO} alt="Apex Vector" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span style={{ fontFamily: fh, fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: 1.5 }}>THE APEX VECTOR STUDIO</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: cs.color }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: cs.color }}>{cs.label}</span>
          </div>
          <h1 style={{ fontFamily: fh, fontSize: 26, fontWeight: 700, color: C.white, lineHeight: 1.3, marginBottom: 6 }}>{l.title}</h1>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 24 }}>{l.source}</div>
          <div style={{ ...crd, padding: 24, marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.textDim, letterSpacing: 1.5, marginBottom: 10 }}>INSIGHT</div>
            <div style={{ fontSize: 15, color: C.white, lineHeight: 1.75, fontWeight: 300 }}>{l.insight}</div>
          </div>
          <div style={{ ...crd, padding: 20, marginBottom: 16, borderColor: C.gold + "44", background: C.goldSoft }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.gold, letterSpacing: 1.5, marginBottom: 8 }}>WHY IT MATTERS</div>
            <div style={{ fontSize: 14, color: C.white, lineHeight: 1.65 }}>{l.why}</div>
          </div>
          <div style={{ ...crd, padding: 20, marginBottom: 16, borderColor: cs.color + "33" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: cs.color, letterSpacing: 1.5, marginBottom: 8 }}>THIS WEEK\'S ACTION</div>
            <div style={{ fontSize: 14, color: C.white, lineHeight: 1.65 }}>{l.action}</div>
          </div>
          <div style={{ ...crd, padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.bc, letterSpacing: 1.5, marginBottom: 10 }}>YOUR REFLECTION</div>
            {je ? (
              <div>
                <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6, fontStyle: "italic" }}>{je.text}</div>
                <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>Written {je.date}</div>
                <button onClick={() => { const nj = { ...jnl }; delete nj[sel]; save({ ...data, journal: nj }); }} style={{ ...btnS, fontSize: 11, color: C.textMut, background: "transparent", marginTop: 8, padding: 0, textDecoration: "underline" }}>Edit</button>
              </div>
            ) : (
              <div>
                <textarea value={jt} onChange={e => setJt(e.target.value)} placeholder="How does this apply to your organization?" style={{ width: "100%", minHeight: 80, background: C.bg3, border: "1px solid " + C.border, borderRadius: 10, color: C.white, fontFamily: fb, fontSize: 14, padding: 12, boxSizing: "border-box" }} />
                {jt.trim() && <button onClick={() => { saveJ(sel, jt); setJt(""); }} style={{ ...btnS, width: "100%", padding: 12, fontSize: 13, fontWeight: 600, color: C.bc, background: "rgba(138,106,174,0.10)", borderRadius: 10, marginTop: 8, border: "1px solid " + C.bc + "33" }}>Save Reflection</button>}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => doComplete(sel)} disabled={dn} style={{ ...btnS, flex: 1, padding: 14, fontSize: 14, fontWeight: 700, color: dn ? C.textDim : "#111111", background: dn ? C.bg3 : C.gold, borderRadius: 12 }}>{dn ? "Completed ✓" : "Mark Complete"}</button>
            <button onClick={() => toggleBm(sel)} style={{ ...btnS, padding: "14px 18px", fontSize: 18, color: bkd ? C.gold : C.textMut, background: C.bg3, border: "1px solid " + C.border, borderRadius: 12 }}>{bkd ? "★" : "☆"}</button>
          </div>
          {(() => {
            const inst = l.source.split("·")[0].trim();
            const related = (srcMap[inst]?.idx || []).filter(i => i !== sel).slice(0, 3);
            if (!related.length) return null;
            return (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textDim, marginBottom: 10 }}>More from {inst}</div>
                {related.map(idx => {
                  const ml = LESSONS[idx];
                  return (
                    <button key={idx} onClick={() => goLesson(idx)} style={{ ...crd, ...btnS, width: "100%", textAlign: "left", padding: "12px 16px", marginBottom: 4 }}>
                      <div style={{ fontFamily: fh, fontSize: 13, fontWeight: 600, color: C.white }}>{ml.title}</div>
                      <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{ml.source}</div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  // SOURCES TAB
  if (tab === "sources") {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: fb, maxWidth: 540, margin: "0 auto", paddingBottom: 80 }}>
        <style>{FCSS}</style>
        <div style={{ padding: "20px 20px 40px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <img src={LOGO} alt="Apex Vector" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span style={{ fontFamily: fh, fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: 1.5 }}>THE APEX VECTOR STUDIO</span>
          </div>
          <h1 style={{ fontFamily: fh, fontSize: 24, fontWeight: 700, color: C.white, marginBottom: 4 }}>Sources</h1>
          <p style={{ fontSize: 12, color: C.textDim, marginBottom: 20 }}>{srcList.length} institutions · {LESSONS.length} lessons</p>
          {srcList.map(inst => {
            const info = srcMap[inst];
            const docs = Object.keys(info.docs);
            const dc = info.idx.filter(i => comp.includes(i)).length;
            return (
              <button key={inst} onClick={() => { setSq(inst); setTab("library"); }} style={{ ...crd, ...btnS, width: "100%", textAlign: "left", padding: 16, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
                    <div style={{ fontFamily: fh, fontSize: 16, fontWeight: 600, color: C.white }}>{inst}</div>
                    {docs.slice(0,2).map(d => <div key={d} style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>{d}</div>)}
                    {docs.length > 2 && <div style={{ fontSize: 11, color: C.textMut, marginTop: 3 }}>+{docs.length - 2} more</div>}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.gold }}>{info.idx.length}</div>
                    <div style={{ fontSize: 9, color: C.textDim }}>{dc}/{info.idx.length}</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <Nav />
      </div>
    );
  }

  // PROGRESS TAB
  if (tab === "stats") {
    const catStats = cats.filter(c => c !== "all").map(cat => {
      const tot = LESSONS.filter(l => l.cat === cat).length;
      const dn = LESSONS.filter((l, i) => l.cat === cat && comp.includes(i)).length;
      return { cat, total: tot, done: dn, pct: tot > 0 ? Math.round((dn / tot) * 100) : 0 };
    });
    const jc = Object.keys(jnl).length;
    return (
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: fb, maxWidth: 540, margin: "0 auto", paddingBottom: 80 }}>
        <style>{FCSS}</style>
        <div style={{ padding: "20px 20px 40px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <img src={LOGO} alt="Apex Vector" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span style={{ fontFamily: fh, fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: 1.5 }}>THE APEX VECTOR STUDIO</span>
          </div>
          <h1 style={{ fontFamily: fh, fontSize: 24, fontWeight: 700, color: C.white, marginBottom: 4 }}>Progress</h1>
          <p style={{ fontSize: 12, color: C.textDim, marginBottom: 20 }}>Technology fluency tracker</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            {[{l:stk.count > 0 ? stk.count+"" : "0",s:"Streak",e:"🔥"},{l:comp.length+"",s:"Done",e:"✓"},{l:jc+"",s:"Reflections",e:"✎"}].map(v => (
              <div key={v.s} style={{ ...crd, flex: 1, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: 10, marginBottom: 4 }}>{v.e}</div>
                <div style={{ fontFamily: fh, fontSize: 22, fontWeight: 700, color: C.gold }}>{v.l}</div>
                <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{v.s}</div>
              </div>
            ))}
          </div>
          <div style={{ ...crd, padding: 16, marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.white }}>Overall Mastery</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.gold }}>{Math.round((comp.length / LESSONS.length) * 100)}%</span>
            </div>
            <div style={{ height: 8, background: C.bg4, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: Math.round((comp.length / LESSONS.length) * 100) + "%", background: "linear-gradient(90deg," + C.gold + "," + C.goldBright + ")", borderRadius: 4, transition: "width 0.5s" }} />
            </div>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>{comp.length} of {LESSONS.length} lessons</div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.textDim, marginBottom: 10 }}>By Pillar</div>
          {catStats.map(s => {
            const cs = getCatStyle(s.cat);
            return (
              <div key={s.cat} style={{ ...crd, padding: 14, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: cs.color }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: cs.color }}>{cs.label}</span>
                  </div>
                  <span style={{ fontSize: 11, color: C.textDim }}>{s.done}/{s.total}</span>
                </div>
                <div style={{ height: 4, background: C.bg4, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: s.pct + "%", background: cs.color, borderRadius: 2, transition: "width 0.5s" }} />
                </div>
              </div>
            );
          })}
          <button onClick={async () => { if (window.confirm("Reset all progress?")) { try { await storageLayer.del(); } catch(e){} setData(defaultData()); }}} style={{ ...btnS, width: "100%", marginTop: 20, padding: 12, fontSize: 12, color: C.textMut, background: "transparent", border: "1px solid " + C.border, borderRadius: 10 }}>Reset All Progress</button>
        </div>
        <Nav />
      </div>
    );
  }

  // LIBRARY TAB
  if (tab === "library") {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: fb, maxWidth: 540, margin: "0 auto", paddingBottom: 80 }}>
        <style>{FCSS}</style>
        <div style={{ padding: "20px 20px 40px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <img src={LOGO} alt="Apex Vector" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span style={{ fontFamily: fh, fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: 1.5 }}>THE APEX VECTOR STUDIO</span>
          </div>
          <h1 style={{ fontFamily: fh, fontSize: 24, fontWeight: 700, color: C.white, marginBottom: 2 }}>Library</h1>
          <p style={{ fontSize: 12, color: C.textDim, marginBottom: 14 }}>{LESSONS.length} lessons · {srcList.length} sources</p>
          <input value={sq} onChange={e => setSq(e.target.value)} placeholder="Search lessons, topics, sources..." style={{ width: "100%", padding: "12px 16px", background: C.bg3, border: "1px solid " + C.border, borderRadius: 10, color: C.white, fontFamily: fb, fontSize: 14, boxSizing: "border-box", marginBottom: 14 }} />
          <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
            {cats.map(cat => {
              const cs = cat === "all" ? { color: C.white, label: "All" } : getCatStyle(cat);
              const active = filter === cat && !sq;
              return (
                <button key={cat} onClick={() => { setFilter(cat); setSq(""); }} style={{ ...btnS, fontSize: 11, fontWeight: 600, color: active ? "#111111" : cs.color, background: active ? cs.color : "transparent", border: "1px solid " + (active ? cs.color : cs.color + "55"), borderRadius: 20, padding: "5px 12px" }}>{cs.label || "All"}</button>
              );
            })}
          </div>
          {bm.length > 0 && !sq && filter === "all" && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.gold, marginBottom: 8 }}>★ Saved ({bm.length})</div>
              {bm.slice(0, 4).map(i => {
                const l = LESSONS[i];
                if (!l) return null;
                return (
                  <button key={i} onClick={() => goLesson(i)} style={{ ...crd, ...btnS, width: "100%", textAlign: "left", padding: "12px 16px", marginBottom: 4 }}>
                    <div style={{ fontFamily: fh, fontSize: 13, fontWeight: 600, color: C.white }}>{l.title}</div>
                    <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{l.source}</div>
                  </button>
                );
              })}
            </div>
          )}
          {fLessons.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textDim }}>No lessons found</div>}
          {fLessons.map(l => {
            const ri = LESSONS.indexOf(l);
            return <LessonCard key={ri} l={l} idx={ri} onClick={() => goLesson(ri)} isDone={comp.includes(ri)} cs={getCatStyle(l.cat)} />;
          })}
        </div>
        <Nav />
      </div>
    );
  }

  // HOME TAB
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: fb, maxWidth: 540, margin: "0 auto", paddingBottom: 80 }}>
      <style>{FCSS}</style>
      <div style={{ padding: "20px 20px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <img src={LOGO} alt="Apex Vector" style={{ width: 24, height: 24, objectFit: "contain" }} />
          <span style={{ fontFamily: fh, fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: 1.5 }}>THE APEX VECTOR STUDIO</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: fh, fontSize: 24, fontWeight: 700, color: C.white, marginBottom: 2, lineHeight: 1.1 }}>Daily Intelligence Boost</h1>
            <p style={{ fontSize: 10, color: C.textDim }}>{srcList.length} sources · {LESSONS.length} lessons</p>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontFamily: fh, fontSize: 22, fontWeight: 700, color: stk.count > 0 ? C.gold : C.textMut }}>{(stk.count > 0 ? stk.count : "0") + " 🔥"}</div>
            <div style={{ fontSize: 10, color: C.textDim }}>day streak</div>
          </div>
        </div>
        <div style={{ marginBottom: 20, padding: "16px 20px", background: C.goldSoft, borderRadius: 12, borderLeft: "3px solid " + C.gold }}>
          <div style={{ fontFamily: fh, fontSize: 15, color: C.white, lineHeight: 1.5, fontStyle: "italic" }}>"{dq.text}"</div>
          <div style={{ fontSize: 11, color: C.goldDim, marginTop: 6 }}>{dq.source}</div>
        </div>
        <div style={{ ...crd, padding: 22, marginBottom: 16, background: "linear-gradient(135deg,#141414,#1c1a18)", borderColor: C.gold + "33" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: getCatStyle(tl.cat).color }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: getCatStyle(tl.cat).color, letterSpacing: 1.5 }}>{"TODAY\'S LESSON · " + getCatStyle(tl.cat).label.toUpperCase()}</span>
          </div>
          <h2 style={{ fontFamily: fh, fontSize: 22, fontWeight: 700, color: C.white, lineHeight: 1.3, marginBottom: 6 }}>{tl.title}</h2>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 14 }}>{tl.source}</div>
          <div style={{ fontSize: 14, color: C.text, lineHeight: 1.65, marginBottom: 16, fontWeight: 300 }}>{tl.insight.length > 180 ? tl.insight.substring(0, 180) + "..." : tl.insight}</div>
          <button onClick={() => goLesson(ti)} style={{ ...btnS, width: "100%", padding: 14, fontSize: 14, fontWeight: 700, color: todayDone ? C.textDim : "#111111", background: todayDone ? C.bg3 : C.gold, borderRadius: 12 }}>{todayDone ? "Review Today\'s Lesson ✓" : "Read Today\'s Lesson"}</button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {[{l:String(comp.length),s:"Completed"},{l:String(LESSONS.length - comp.length),s:"Remaining"},{l:String(bm.length),s:"Saved"}].map(v => (
            <div key={v.s} style={{ ...crd, flex: 1, padding: 12, textAlign: "center" }}>
              <div style={{ fontFamily: fh, fontSize: 18, fontWeight: 700, color: C.gold }}>{v.l}</div>
              <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{v.s}</div>
            </div>
          ))}
        </div>
        <div style={{ ...crd, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: C.textDim }}>Mastery Progress</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: C.gold }}>{Math.round((comp.length / LESSONS.length) * 100)}%</span>
          </div>
          <div style={{ height: 6, background: C.bg4, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: Math.round((comp.length / LESSONS.length) * 100) + "%", background: "linear-gradient(90deg," + C.gold + "," + C.goldBright + ")", borderRadius: 3, transition: "width 0.5s" }} />
          </div>
        </div>
        {comp.length < LESSONS.length && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.textDim, marginBottom: 8 }}>Up Next</div>
            {[1,2,3].map(off => {
              let idx = (ti + off) % LESSONS.length;
              let tries = 0;
              while (comp.includes(idx) && tries < LESSONS.length) { idx = (idx + 1) % LESSONS.length; tries++; }
              if (comp.includes(idx)) return null;
              const l = LESSONS[idx];
              const cs = getCatStyle(l.cat);
              return (
                <button key={idx+"-"+off} onClick={() => goLesson(idx)} style={{ ...crd, ...btnS, width: "100%", textAlign: "left", padding: "14px 16px", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: cs.color, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: fh, fontSize: 13, fontWeight: 600, color: C.white }}>{l.title}</div>
                      <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{l.source}</div>
                    </div>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: cs.color, opacity: 0.4 }} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {bm.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.gold, marginBottom: 8 }}>★ Saved ({bm.length})</div>
            {bm.slice(0, 2).map(i => {
              const l = LESSONS[i];
              if (!l) return null;
              return (
                <button key={i} onClick={() => goLesson(i)} style={{ ...crd, ...btnS, width: "100%", textAlign: "left", padding: "12px 16px", marginBottom: 4 }}>
                  <div style={{ fontFamily: fh, fontSize: 13, fontWeight: 600, color: C.white }}>{l.title}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{l.source}</div>
                </button>
              );
            })}
          </div>
        )}
        <div style={{ textAlign: "center", padding: "16px 0 8px", fontSize: 10, color: C.textMut }}>The Apex Vector Studio</div>
      </div>
      <Nav />
    </div>
  );
}
