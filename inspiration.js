// ═══════════════════════════════════════════════════════════════
// INSPIRATION V1
// Every card is a direct shortcut into a pre-filled generator.
// BrandCore is always injected automatically at generation time.
// ═══════════════════════════════════════════════════════════════

var INSP_CATS = ["campaign","visual","ugc","web","text"];

// ── Curated inspiration data ─────────────────────────────────────
// prefill keys match CF_FLOWS step keys exactly.
// Format: { val: "...", label: "..." } — val goes into S._builder,
// label is shown in the history strip when auto-advancing.

var INSP_DATA = {

  campaign: {
    label:  "Trending Campaigns",
    emoji:  "🔥",
    color:  "#A78BFA",
    type:   "campaign",
    ideas: [
      {
        label:  "Premium Product Launch",
        desc:   "Cinematic reveal campaign for a new product. Tease → reveal → educate → convert.",
        bg:     "linear-gradient(140deg,#12053A,#0A0A0A)",
        accent: "#A78BFA",
        lbl:    "LAUNCH", hl: "Something arrives.",
        prefill: {
          campPromotion: { val:"Premium new product launch",                                          label:"Premium new product launch" },
          campGoal:      { val:"launch",                                                              label:"Product Launch" },
          campCount:     { val:"4",                                                                   label:"4 Ads" },
          campAudience:  { val:"Premium buyers and early adopters seeking exclusive access",          label:"Premium buyers, early adopters" },
          campOffer:     { val:"Exclusive first access — limited initial launch",                     label:"Exclusive first access" },
          campVisuals:   { val:"Dark studio photography. Hero product on matte black surface with dramatic side lighting. Smoke wisps. Premium brand accent lighting.",  label:"Dark studio photography..." },
          _extraNotes:   { val:"Cinematic, premium tone. Build anticipation before reveal. Restrained and confident.",  label:"Cinematic, premium..." }
        }
      },
      {
        label:  "Brand Awareness Series",
        desc:   "Storytelling-first campaign. Build recognition before selling. Five touchpoints, one consistent voice.",
        bg:     "linear-gradient(140deg,#200A0A,#0A0A0A)",
        accent: "#F87171",
        lbl:    "STORY", hl: "Feel first. Then decide.",
        prefill: {
          campPromotion: { val:"Brand story and founding vision",                                     label:"Brand story and founding vision" },
          campGoal:      { val:"awareness",                                                           label:"Brand Awareness" },
          campCount:     { val:"5",                                                                   label:"5 Ads" },
          campAudience:  { val:"New audiences unfamiliar with the brand — cold traffic",              label:"New audiences, cold traffic" },
          campOffer:     { val:"Who we are, why we exist, what we stand for",                         label:"Brand story" },
          campVisuals:   { val:"Authentic, editorial photography. Real people, real environments. Warm natural light. Genuine moments that feel lived-in, not staged.",   label:"Editorial, authentic visuals..." },
          _extraNotes:   { val:"No hard sell. Build trust and emotional connection first. Consistent visual language across all five ads.",  label:"No hard sell..." }
        }
      },
      {
        label:  "High-Converting Lead Gen",
        desc:   "Value-first lead capture. Offer something undeniable. Reduce friction to zero at every step.",
        bg:     "linear-gradient(140deg,#070A1C,#121426)",
        accent: "#818CF8",
        lbl:    "LEADS", hl: "One clear action.",
        prefill: {
          campPromotion: { val:"Free resource, guide, or tool that solves a real problem",           label:"Free resource / lead magnet" },
          campGoal:      { val:"leads",                                                              label:"Lead Generation" },
          campCount:     { val:"4",                                                                  label:"4 Ads" },
          campAudience:  { val:"Problem-aware decision makers actively searching for solutions",     label:"Problem-aware decision makers" },
          campOffer:     { val:"Free guide, checklist, or trial — immediate value, no payment required",  label:"Free resource" },
          campVisuals:   { val:"Clean professional environment. Product or resource mockup prominently featured. Minimal, conversion-focused layout. No distractions.",  label:"Clean, professional..." },
          _extraNotes:   { val:"Remove all friction. Single strong CTA. Social proof near the offer. Trust signals prominent.",  label:"Remove friction..." }
        }
      },
      {
        label:  "Social Proof Sprint",
        desc:   "Let customers lead. Real results, real voices. A campaign built entirely on credibility.",
        bg:     "linear-gradient(140deg,#081A12,#0A0A0A)",
        accent: "#34D399",
        lbl:    "PROOF", hl: "They said it. Not us.",
        prefill: {
          campPromotion: { val:"Customer results and real-world success stories",                    label:"Customer results and proof" },
          campGoal:      { val:"sales",                                                              label:"Sales" },
          campCount:     { val:"4",                                                                  label:"4 Ads" },
          campAudience:  { val:"Consideration-stage buyers who are aware but not yet convinced",    label:"Consideration-stage buyers" },
          campOffer:     { val:"Real customer results with specific numbers and timelines",          label:"Real customer results" },
          campVisuals:   { val:"Real customer faces or environments. Screenshots of results. Before/after format. Authentic, unpolished feel that earns trust.",  label:"Real customers, authentic..." },
          _extraNotes:   { val:"Specific proof only — no vague testimonials. Numbers, timelines, names. Credibility above all.",  label:"Specific, credible proof..." }
        }
      },
      {
        label:  "Viral Hook Sequence",
        desc:   "Community-first growth. Every ad is a hook, not a pitch. Designed to spread before it sells.",
        bg:     "linear-gradient(140deg,#160833,#0A0A0A)",
        accent: "#C084FC",
        lbl:    "VIRAL", hl: "Built to spread.",
        prefill: {
          campPromotion: { val:"Brand community and organic growth content",                        label:"Community and growth content" },
          campGoal:      { val:"community",                                                         label:"Community Growth" },
          campCount:     { val:"5",                                                                 label:"5 Ads" },
          campAudience:  { val:"Content creators, early adopters, and brand evangelists",           label:"Creators and early adopters" },
          campOffer:     { val:"Something worth sharing — insight, provocation, or exclusive perspective",  label:"Share-worthy content" },
          campVisuals:   { val:"Native, fast-paced visual style. Bold text hooks. High energy. Feels organic, not produced. Authentic creator aesthetic.", label:"Native, organic energy..." },
          _extraNotes:   { val:"Hook must land in 2 seconds. Pattern interrupt every variation. Bold, direct, unapologetic.", label:"2-second hook..." }
        }
      },
      {
        label:  "Seasonal Drop Campaign",
        desc:   "Urgency anchored to a moment. Build anticipation, drop hard, close with a final push.",
        bg:     "linear-gradient(140deg,#0A1828,#06091A)",
        accent: "#60A5FA",
        lbl:    "SEASONAL", hl: "The moment is now.",
        prefill: {
          campPromotion: { val:"Limited seasonal product or offer",                                  label:"Limited seasonal offer" },
          campGoal:      { val:"sales",                                                              label:"Sales" },
          campCount:     { val:"3",                                                                  label:"3 Ads" },
          campAudience:  { val:"Existing audience and warm retargeting pool already familiar with the brand",  label:"Existing and warm audience" },
          campOffer:     { val:"Limited edition — only available for a defined time period",         label:"Limited edition, time-bound" },
          campVisuals:   { val:"Seasonal palette and atmosphere. Warm or cool tones matching the moment. Premium product photography with season-specific props and lighting.",  label:"Seasonal atmosphere..." },
          _extraNotes:   { val:"Genuine urgency — real deadline, real scarcity. Tease first, reveal on day of, close with 48-hour final push.", label:"Real urgency, tease first..." }
        }
      },
      {
        label:  "Founder Story Campaign",
        desc:   "The person behind the brand becomes the campaign. Raw ambition, personal risk, and the reason it all started.",
        bg:     "linear-gradient(140deg,#180A06,#0A0A0A)",
        accent: "#F97316",
        lbl:    "FOUNDER", hl: "Why I started this.",
        prefill: {
          campPromotion: { val:"Founder story — the personal journey behind the brand",              label:"Founder story campaign" },
          campGoal:      { val:"awareness",                                                          label:"Brand Awareness" },
          campCount:     { val:"4",                                                                  label:"4 Ads" },
          campAudience:  { val:"Mission-driven consumers who want to know the people behind the products they buy",  label:"Mission-driven consumers" },
          campOffer:     { val:"The founder's honest story — why they started, what they risked, what they built",  label:"Honest founder story" },
          campVisuals:   { val:"Candid, intimate photography of the founder in their real environment. Behind-the-scenes moments. Authentic lighting — no studio polish. Makes the viewer feel close.",  label:"Candid founder photography..." },
          _extraNotes:   { val:"Personal, vulnerable, and real. This campaign wins by making people trust the person first. No hard sell — connection is the objective.",  label:"Connection over selling..." }
        }
      },
      {
        label:  "Referral Growth Campaign",
        desc:   "Turn your best customers into your strongest growth engine. Every ad is an invitation with social proof attached.",
        bg:     "linear-gradient(140deg,#081408,#0A0A0A)",
        accent: "#4ADE80",
        lbl:    "REFER", hl: "Tell someone you know.",
        prefill: {
          campPromotion: { val:"Referral program — reward customers for inviting people they trust",  label:"Referral program" },
          campGoal:      { val:"community",                                                           label:"Community Growth" },
          campCount:     { val:"3",                                                                   label:"3 Ads" },
          campAudience:  { val:"Existing satisfied customers who are natural advocates for the brand",  label:"Existing brand advocates" },
          campOffer:     { val:"A meaningful reward for both referrer and friend — double-sided incentive",  label:"Double-sided referral reward" },
          campVisuals:   { val:"Warmth and connection. Real people, genuine moments. Two-person framing — the idea of sharing something good with someone you care about.",  label:"Connection and warmth..." },
          _extraNotes:   { val:"The offer must feel generous enough to actually share. Lead with the benefit to the friend, not just the referrer. Social proof from real customers throughout.",  label:"Generous offer, friend-first..." }
        }
      },
      {
        label:  "Community Growth Campaign",
        desc:   "Build a movement, not just a customer list. Turn passive buyers into an active brand community.",
        bg:     "linear-gradient(140deg,#0A0A1C,#0A0A14)",
        accent: "#818CF8",
        lbl:    "COMMUNITY", hl: "You belong here.",
        prefill: {
          campPromotion: { val:"Brand community — the tribe behind the brand",                      label:"Brand community campaign" },
          campGoal:      { val:"community",                                                          label:"Community Growth" },
          campCount:     { val:"4",                                                                  label:"4 Ads" },
          campAudience:  { val:"Like-minded people who share a belief, lifestyle, or aspiration connected to the brand",  label:"Like-minded audience, shared belief" },
          campOffer:     { val:"Access — to a community, a mindset, and a group of people who get it",  label:"Access and belonging" },
          campVisuals:   { val:"Group energy and collective momentum. Real community members. Shared activities, shared goals, shared identity. Feels like something worth joining.",  label:"Group energy, collective momentum..." },
          _extraNotes:   { val:"Sell the identity, not the product. People join communities that reflect who they are or who they want to become. The product is how they access the tribe.",  label:"Sell identity, not product..." }
        }
      },
      {
        label:  "Limited-Time Offer Campaign",
        desc:   "Real urgency with real rewards. A campaign built to convert today, not eventually.",
        bg:     "linear-gradient(140deg,#1A0A08,#100806)",
        accent: "#FB923C",
        lbl:    "LIMITED", hl: "This won't last.",
        prefill: {
          campPromotion: { val:"Time-limited promotional offer — discount or bonus for a fixed window",  label:"Time-limited offer" },
          campGoal:      { val:"sales",                                                                  label:"Sales" },
          campCount:     { val:"3",                                                                      label:"3 Ads" },
          campAudience:  { val:"Warm audience — people who already know the brand but haven't yet converted",  label:"Warm unconverted audience" },
          campOffer:     { val:"Exclusive limited-window discount or bonus — real scarcity, real deadline",  label:"Genuine time-limited offer" },
          campVisuals:   { val:"Bold, direct, urgent. Strong product close-up. Clear deadline date. No distractions — eye to product to CTA.",  label:"Bold, urgent, product close-up..." },
          _extraNotes:   { val:"Real urgency only — no fake countdowns. The scarcity must be true or it destroys trust. Make the offer so good that ignoring it feels like a mistake.",  label:"Real urgency, irresistible offer..." }
        }
      },
      {
        label:  "Challenger Brand Campaign",
        desc:   "Reframe the category. The underdog who breaks the rules the incumbent wrote.",
        bg:     "linear-gradient(140deg,#14040C,#0A0808)",
        accent: "#E11D48",
        lbl:    "CHALLENGER", hl: "They won't like this.",
        prefill: {
          campPromotion: { val:"Brand positioning — why we do things differently and better",       label:"Challenger positioning" },
          campGoal:      { val:"awareness",                                                          label:"Brand Awareness" },
          campCount:     { val:"4",                                                                  label:"4 Ads" },
          campAudience:  { val:"Buyers frustrated with existing options — people who feel underserved by the category leader",  label:"Frustrated category buyers" },
          campOffer:     { val:"A better alternative that doesn't play by the old rules",            label:"The better alternative" },
          campVisuals:   { val:"Provocative, bold, contrarian. Dark energy and confident design. Feels like a brand that doesn't care about being liked by everyone — only by the right ones.",  label:"Provocative, bold, contrarian..." },
          _extraNotes:   { val:"Never name the competition. Attack the category norms, not the competitor. The ad should make the target audience feel seen and the mainstream feel slightly uncomfortable.",  label:"Attack norms, never the competitor..." }
        }
      },
      {
        label:  "Retargeting Comeback Campaign",
        desc:   "Re-engage the warm audience that didn't convert first time. Close the gap between interest and decision.",
        bg:     "linear-gradient(140deg,#040C14,#06101A)",
        accent: "#38BDF8",
        lbl:    "RETARGET", hl: "You were close.",
        prefill: {
          campPromotion: { val:"Retargeting offer — a final push for warm visitors who left without buying",  label:"Retargeting campaign" },
          campGoal:      { val:"sales",                                                                       label:"Sales" },
          campCount:     { val:"3",                                                                           label:"3 Ads" },
          campAudience:  { val:"Visitors who showed interest but didn't convert — they already know the brand",  label:"Warm non-converting audience" },
          campOffer:     { val:"Remove the final objection — address the hesitation directly and make the next step feel easy",  label:"Remove the last objection" },
          campVisuals:   { val:"Familiar but fresh — feels like a natural follow-up, not an aggressive push. Product-forward. Clean and direct. A reminder of what they were considering.",  label:"Familiar follow-up, product-forward..." },
          _extraNotes:   { val:"Reference their prior interest without being creepy. Address the most common objection in the headline. Use a softer CTA than cold audience campaigns.",  label:"Acknowledge prior interest, address objection..." }
        }
      }
    ]
  },

  visual: {
    label:  "Trending Visual Styles",
    emoji:  "🎨",
    color:  "#3B82F6",
    type:   "image",
    ideas: [
      {
        label:  "Dark Luxury Product",
        desc:   "Hero product on near-black surface. Dramatic side lighting. Premium and cinematic.",
        bg:     "linear-gradient(140deg,#100C04,#0A0A0A)",
        accent: "#C9AA71",
        lbl:    "LUXURY", hl: "Silence speaks.",
        prefill: {
          imgVisualType: { val:"product",    label:"Product Visual" },
          imgPurpose:    { val:"promote",    label:"Promote Product" },
          imgAbout:      { val:"Premium product — hero object, nothing else competing for attention",  label:"Premium hero product" },
          imgTextContent:{ val:"",           label:"No text — pure visual" },
          imgScene:      { val:"Hero product centered on a near-black matte surface. Dramatic raking side light casting sharp shadows. One subtle accent light in brand colour. Minimal environment — nothing competes with the product. Smoke or vapour wisps optional.", label:"Dark matte surface, raking light..." },
          imgFormat:     { val:"4:5",        label:"Portrait 4:5" },
          _extraNotes:   { val:"Ultra-premium, cinematic feel. Restraint is the loudest design decision. No clutter.", label:"Ultra-premium, restrained..." }
        }
      },
      {
        label:  "Cinematic Sports Energy",
        desc:   "Dynamic athlete in motion. High energy captured in a single decisive frame.",
        bg:     "linear-gradient(140deg,#1A0404,#0A0A0A)",
        accent: "#EF4444",
        lbl:    "SPORT", hl: "Pure velocity.",
        prefill: {
          imgVisualType: { val:"social",     label:"Social Media Post" },
          imgPurpose:    { val:"awareness",  label:"Build Awareness" },
          imgAbout:      { val:"Athletic performance — raw energy, motion, and intensity",  label:"Athletic performance and energy" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Athlete in dynamic peak action — weight lifting, sprinting, or jumping. Shot from a low angle. Motion blur on extremities, sharp face. Dramatic stadium or gym environment. High contrast with brand accent lighting.", label:"Athlete in peak action, low angle..." },
          imgFormat:     { val:"4:5",        label:"Portrait 4:5" },
          _extraNotes:   { val:"Raw energy. Every pixel should feel like effort and intensity. Not polished — powerful.", label:"Raw energy, powerful..." }
        }
      },
      {
        label:  "Minimal Editorial",
        desc:   "Generous white space, one strong focal point, deliberate typography. Nothing is accidental.",
        bg:     "linear-gradient(140deg,#141414,#1A1A1A)",
        accent: "#D1D5DB",
        lbl:    "MINIMAL", hl: "Less. But better.",
        prefill: {
          imgVisualType: { val:"poster",     label:"Poster" },
          imgPurpose:    { val:"awareness",  label:"Build Awareness" },
          imgAbout:      { val:"Brand identity — clean, considered, premium positioning",  label:"Brand identity, premium" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Single object or subject centered in abundant white or light neutral space. Negative space is the design. Soft, diffused natural light. Shadow falls with intention. Nothing included that isn't needed.", label:"Single object, abundant space..." },
          imgFormat:     { val:"1:1",        label:"Square 1:1" },
          _extraNotes:   { val:"Restraint is the design. If in doubt, remove it. The quieter it is, the more premium it feels.", label:"Restraint is the design..." }
        }
      },
      {
        label:  "Futuristic Tech Interface",
        desc:   "Dark surfaces, glowing data accents, technical precision. Intelligence made visible.",
        bg:     "linear-gradient(140deg,#040E20,#08101E)",
        accent: "#22D3EE",
        lbl:    "FUTURE", hl: "Intelligence, visible.",
        prefill: {
          imgVisualType: { val:"website",    label:"Website Graphic" },
          imgPurpose:    { val:"launch",     label:"Launch Campaign" },
          imgAbout:      { val:"AI or technology product — showing intelligent interface and capability",  label:"AI / tech product interface" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Dark near-black environment with glowing UI elements, data visualisations, or floating interface panels. Cool blue and cyan accent glows. Clean geometric lines. Sense of depth through layered surfaces and subtle light.", label:"Dark environment, glowing UI panels..." },
          imgFormat:     { val:"16:9",       label:"Landscape 16:9" },
          _extraNotes:   { val:"Futuristic but grounded. Intelligence should feel tangible. Not science fiction — near-future reality.", label:"Near-future, tangible intelligence..." }
        }
      },
      {
        label:  "Organic Premium",
        desc:   "Earthy tones, natural light, authentic textures. Honest and non-corporate by design.",
        bg:     "linear-gradient(140deg,#081408,#0A1208)",
        accent: "#86EFAC",
        lbl:    "ORGANIC", hl: "Rooted in nature.",
        prefill: {
          imgVisualType: { val:"product",    label:"Product Visual" },
          imgPurpose:    { val:"promote",    label:"Promote Product" },
          imgAbout:      { val:"Natural, organic, or wellness product — authentic and grounded",  label:"Natural / wellness product" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Product surrounded by natural elements — botanicals, raw textures, linen, stone, or earth. Soft natural side light from a window. Warm neutral tones — cream, terracotta, sage, natural wood. Candid and unposed.", label:"Natural elements, warm neutral tones..." },
          imgFormat:     { val:"4:5",        label:"Portrait 4:5" },
          _extraNotes:   { val:"Anti-corporate by design. Imperfect is better than polished here. Real over perfect.", label:"Authentic, imperfect, real..." }
        }
      },
      {
        label:  "Bold Geometric Abstraction",
        desc:   "Strong shapes, mathematical precision. Maximum visual impact without any photography.",
        bg:     "linear-gradient(140deg,#08081C,#0F0F14)",
        accent: "#B7FF2A",
        lbl:    "ABSTRACT", hl: "Shape your world.",
        prefill: {
          imgVisualType: { val:"poster",     label:"Poster" },
          imgPurpose:    { val:"awareness",  label:"Build Awareness" },
          imgAbout:      { val:"Brand identity or campaign visual — pure graphic design, no photography",  label:"Brand graphic, no photography" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Bold geometric composition — overlapping shapes, hard edges, strong grid. Brand colours applied with confidence. High contrast. One dominant form with supporting elements. Feels designed, not photographed.", label:"Bold geometric composition, brand colours..." },
          imgFormat:     { val:"1:1",        label:"Square 1:1" },
          _extraNotes:   { val:"Graphic design over photography. Mathematical precision. The composition IS the message.", label:"Design over photography..." }
        }
      },
      {
        label:  "Feature Spotlight",
        desc:   "One product feature. Maximum visual clarity. The benefit is unmissable.",
        bg:     "linear-gradient(140deg,#06101C,#080E18)",
        accent: "#60A5FA",
        lbl:    "FEATURE", hl: "You'll want to see this.",
        prefill: {
          imgVisualType: { val:"social",     label:"Social Media Post" },
          imgPurpose:    { val:"promote",    label:"Promote Product" },
          imgAbout:      { val:"Single standout product feature — isolated and visualised for maximum clarity",  label:"Product feature spotlight" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Product with one specific feature highlighted — through lighting, callout, zoom, or isolation. Clean background. The feature is the hero, not the product as a whole. Crystal-clear visual communication of one benefit.", label:"Feature as hero, single benefit..." },
          imgFormat:     { val:"1:1",        label:"Square 1:1" },
          _extraNotes:   { val:"One message, one feature, one image. If you're communicating two things, you're communicating nothing. The benefit must be obvious without any caption.", label:"One message, one feature..." }
        }
      },
      {
        label:  "Before & After Visual",
        desc:   "The most powerful proof format in visual advertising. Show the transformation clearly.",
        bg:     "linear-gradient(140deg,#0C1208,#0A0A0A)",
        accent: "#86EFAC",
        lbl:    "BEFORE/AFTER", hl: "The difference is clear.",
        prefill: {
          imgVisualType: { val:"social",     label:"Social Media Post" },
          imgPurpose:    { val:"promote",    label:"Promote Product" },
          imgAbout:      { val:"Before and after transformation — the product result made visually undeniable",  label:"Transformation visual" },
          imgTextContent:{ val:"Before · After", label:"Before · After labels" },
          imgScene:      { val:"Split composition: left shows the 'before' state (problem or baseline), right shows the 'after' state (result, solved, transformed). Strong contrast between the two states. Typography labels minimal and clean.", label:"Split before/after, dramatic contrast..." },
          imgFormat:     { val:"1:1",        label:"Square 1:1" },
          _extraNotes:   { val:"The contrast must be dramatic enough to do the work without copy. Real results beat staged ones. Make the after state aspirational but believable.", label:"Dramatic contrast, believable results..." }
        }
      },
      {
        label:  "Social Announcement Graphic",
        desc:   "Bold announcement energy. Big news deserves a big visual moment.",
        bg:     "linear-gradient(140deg,#0C0820,#0A0618)",
        accent: "#C084FC",
        lbl:    "ANNOUNCE", hl: "Something just changed.",
        prefill: {
          imgVisualType: { val:"social",     label:"Social Media Post" },
          imgPurpose:    { val:"launch",     label:"Launch Campaign" },
          imgAbout:      { val:"Brand announcement — news, a launch, or a milestone worth sharing",  label:"Brand announcement" },
          imgTextContent:{ val:"Announcement headline", label:"Announcement headline" },
          imgScene:      { val:"High-energy announcement graphic. Bold typography as the hero element. Brand accent colour at full saturation. Clean dark background. Feels like something important just happened and the world needs to know.", label:"Bold type, brand colour at full saturation..." },
          imgFormat:     { val:"4:5",        label:"Portrait 4:5" },
          _extraNotes:   { val:"Typography IS the visual. The headline should stop the scroll entirely. No image clutter — let the words carry the weight of the announcement.", label:"Typography as the visual, headline stops the scroll..." }
        }
      },
      {
        label:  "Lifestyle Flat Lay",
        desc:   "Product styled in a curated real-world context. Aspirational but achievable.",
        bg:     "linear-gradient(140deg,#100A06,#0A0A0A)",
        accent: "#FBBF24",
        lbl:    "FLATLAY", hl: "A life well-styled.",
        prefill: {
          imgVisualType: { val:"product",    label:"Product Visual" },
          imgPurpose:    { val:"promote",    label:"Promote Product" },
          imgAbout:      { val:"Product in a styled flat lay — real lifestyle context, curated but authentic",  label:"Styled lifestyle flat lay" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Overhead flat lay shot. Product surrounded by complementary lifestyle props — books, coffee, materials, textures that match the brand aesthetic. Warm natural side light. Surface texture deliberately chosen. Every prop earns its place.", label:"Overhead flat lay, lifestyle props, brand palette..." },
          imgFormat:     { val:"1:1",        label:"Square 1:1" },
          _extraNotes:   { val:"Curated but not over-styled. It should feel real enough to imagine your own life in it. Colour palette of all props must be consistent with brand identity.", label:"Curated but real, brand-consistent..." }
        }
      },
      {
        label:  "Brand Colour Showcase",
        desc:   "Pure brand palette expression. A graphic that makes your colour system feel intentional and premium.",
        bg:     "linear-gradient(140deg,#0A0A0A,#141414)",
        accent: "#F0F0F0",
        lbl:    "PALETTE", hl: "This is how we look.",
        prefill: {
          imgVisualType: { val:"poster",     label:"Poster" },
          imgPurpose:    { val:"awareness",  label:"Build Awareness" },
          imgAbout:      { val:"Brand identity visual — a pure expression of the brand colour system and visual language",  label:"Brand colour identity" },
          imgTextContent:{ val:"",           label:"No text" },
          imgScene:      { val:"Colour-first composition. Brand palette expressed through geometric blocks, gradient washes, or layered shapes. The visual language of the brand made tangible — what our aesthetic actually looks like as pure design.", label:"Brand palette in geometric composition..." },
          imgFormat:     { val:"4:5",        label:"Portrait 4:5" },
          _extraNotes:   { val:"This is a brand identity visual, not a product ad. Colour choices must be exact to the brand palette. Clean, intentional, and impossible to mistake for another brand.", label:"Pure brand identity, unmistakable..." }
        }
      },
      {
        label:  "Text-Led Graphic",
        desc:   "The copy is the visual. Bold typography with nothing competing for attention.",
        bg:     "linear-gradient(140deg,#080808,#141414)",
        accent: "#D1D5DB",
        lbl:    "TYPE", hl: "Words that hit.",
        prefill: {
          imgVisualType: { val:"social",     label:"Social Media Post" },
          imgPurpose:    { val:"awareness",  label:"Build Awareness" },
          imgAbout:      { val:"Text-led social graphic — a powerful quote, statement, or hook as the primary design element",  label:"Text-led design" },
          imgTextContent:{ val:"[Brand quote or hook]", label:"Brand quote or hook" },
          imgScene:      { val:"Typographic design. One or two lines of bold text set large against a strong background in brand colours. Minimal supporting elements. The text occupies 50–80% of the frame. High contrast — white or brand-colour text on dark background.", label:"Large bold type, minimal support..." },
          imgFormat:     { val:"4:5",        label:"Portrait 4:5" },
          _extraNotes:   { val:"Typography choice, weight, and spacing IS the design. The quote or hook must be worth reading — no filler words. Typeface should reflect brand personality.", label:"Type as design, every word earns its place..." }
        }
      }
    ]
  },

  ugc: {
    label:  "Trending UGC Concepts",
    emoji:  "📱",
    color:  "#F59E0B",
    type:   "ugc",
    ideas: [
      {
        label:  "Founder Story",
        desc:   "Raw and personal. Why you built this, what you risked, what you believe. Direct to camera.",
        bg:     "linear-gradient(140deg,#1A1408,#0A0A0A)",
        accent: "#FBBF24",
        lbl:    "FOUNDER", hl: "This is why I built this.",
        prefill: {
          ucScriptMode:  { val:"ai",       label:"Write with AI" },
          ucAdFeeling:   { val:"emotional", label:"Emotional" },
          ucGoal:        { val:"awareness", label:"Brand Awareness" },
          ucContext:     { val:"Founder story: why I started this brand, what I gave up, what I discovered along the way, and what I'm building for the future. Personal, raw, and real.", label:"Founder story — personal and raw" }
        }
      },
      {
        label:  "Quick Win Demo",
        desc:   "Show one specific result in under 30 seconds. Hook with the outcome, explain the product.",
        bg:     "linear-gradient(140deg,#081A08,#0A0A0A)",
        accent: "#34D399",
        lbl:    "DEMO", hl: "See the result first.",
        prefill: {
          ucScriptMode:  { val:"ai",      label:"Write with AI" },
          ucAdFeeling:   { val:"startup", label:"Startup" },
          ucGoal:        { val:"sales",   label:"Drive Sales" },
          ucContext:     { val:"Quick product demo showing one specific impressive result. Hook with the outcome in the first 3 seconds, then reveal how the product makes it happen. End with a clear next step.", label:"Quick demo — outcome first" }
        }
      },
      {
        label:  "Day in the Life",
        desc:   "Lifestyle integration. Show the product living naturally in a real, relatable routine.",
        bg:     "linear-gradient(140deg,#0A1828,#06091A)",
        accent: "#60A5FA",
        lbl:    "LIFESTYLE", hl: "This is how I live.",
        prefill: {
          ucScriptMode:  { val:"ai",        label:"Write with AI" },
          ucAdFeeling:   { val:"friendly",  label:"Friendly" },
          ucGoal:        { val:"awareness", label:"Brand Awareness" },
          ucContext:     { val:"Day in the life showing how this product fits naturally into a real daily routine. Authentic, relatable moments — morning routine, work, evening wind-down. Product integration feels genuine, not forced.", label:"Day-in-the-life, authentic integration" }
        }
      },
      {
        label:  "Customer Transformation",
        desc:   "Real before/after. Specific numbers, honest timeline, relatable starting point.",
        bg:     "linear-gradient(140deg,#1C0A1C,#0A0A0A)",
        accent: "#E879F9",
        lbl:    "RESULTS", hl: "Look what changed.",
        prefill: {
          ucScriptMode:  { val:"ai",         label:"Write with AI" },
          ucAdFeeling:   { val:"emotional",  label:"Emotional" },
          ucGoal:        { val:"sales",      label:"Drive Sales" },
          ucContext:     { val:"Customer transformation story: where they started, what they struggled with, how this product changed things, and the specific result they achieved. Include real numbers if possible. Conversational and honest.", label:"Customer transformation — real results" }
        }
      },
      {
        label:  "Unboxing Reveal",
        desc:   "First impression experience. Pure excitement and discovery. Let the product speak first.",
        bg:     "linear-gradient(140deg,#120E04,#0A0A0A)",
        accent: "#C9AA71",
        lbl:    "UNBOXING", hl: "First impressions.",
        prefill: {
          ucScriptMode:  { val:"ai",       label:"Write with AI" },
          ucAdFeeling:   { val:"viral",    label:"Viral" },
          ucGoal:        { val:"launch",   label:"Product Launch" },
          ucContext:     { val:"Unboxing and first impression reveal. Build anticipation during the opening, express genuine reactions to the product, highlight unexpected quality moments, and end with a clear 'you need this' moment.", label:"Unboxing reveal — genuine excitement" }
        }
      },
      {
        label:  "Expert Insight Hook",
        desc:   "Authority through value. Teach something surprising first. The product is the logical next step.",
        bg:     "linear-gradient(140deg,#041818,#0A0A0A)",
        accent: "#22D3EE",
        lbl:    "EXPERT", hl: "We know this field.",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"cinematic",   label:"Cinematic" },
          ucGoal:        { val:"clicks",      label:"Website Clicks" },
          ucContext:     { val:"Expert insight hook: share one counter-intuitive truth about the industry that most people get wrong, explain why it matters, then naturally introduce the product as the solution most people are missing.", label:"Expert insight — counter-intuitive truth" }
        }
      },
      {
        label:  "Customer Testimonial",
        desc:   "Real customers, real results. The most trusted voice in any room is the person who already bought.",
        bg:     "linear-gradient(140deg,#0A1408,#080E06)",
        accent: "#4ADE80",
        lbl:    "TESTIMONIAL", hl: "I wasn't sure. Now I am.",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"emotional",   label:"Emotional" },
          ucGoal:        { val:"sales",       label:"Drive Sales" },
          ucContext:     { val:"Customer testimonial video: start with their specific hesitation before buying, describe the turning point when they decided to try it, and end with the specific result they experienced. Real numbers and specific outcomes wherever possible. Conversational and unscripted in feel.", label:"Customer testimonial — hesitation to result" }
        }
      },
      {
        label:  "Problem & Solution",
        desc:   "Name the pain exactly. Then show the fix. The most direct path from problem to product.",
        bg:     "linear-gradient(140deg,#100406,#0A0808)",
        accent: "#F87171",
        lbl:    "PROBLEM/SOLVE", hl: "You've felt this too.",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"startup",     label:"Startup" },
          ucGoal:        { val:"sales",       label:"Drive Sales" },
          ucContext:     { val:"Problem/solution format: open by naming the exact problem in one sentence — make the viewer say 'yes, that's me'. Build the frustration briefly. Then introduce the product as the direct solution. Close with the specific outcome. Hook in the first 3 seconds. Clear CTA at the end.", label:"Problem/solution — name the pain, show the fix" }
        }
      },
      {
        label:  "Behind the Scenes",
        desc:   "Transparency builds trust. Show what most brands hide. The process, the people, the real story.",
        bg:     "linear-gradient(140deg,#0A0A0A,#181818)",
        accent: "#9CA3AF",
        lbl:    "BTS", hl: "This is how it's made.",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"friendly",    label:"Friendly" },
          ucGoal:        { val:"awareness",   label:"Brand Awareness" },
          ucContext:     { val:"Behind the scenes video showing the real process behind the product or brand. Could be manufacturing, team culture, the office, sourcing, or quality control. Tone: transparent, candid, and proud. Show what makes this brand different from the inside out. Raw is better than overproduced here.", label:"BTS — process, people, real story" }
        }
      },
      {
        label:  "Quick Review",
        desc:   "Thirty seconds. One honest opinion. The fast-format review that converts at the moment of discovery.",
        bg:     "linear-gradient(140deg,#04100A,#040E08)",
        accent: "#34D399",
        lbl:    "REVIEW", hl: "Honest. 30 seconds.",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"viral",       label:"Viral" },
          ucGoal:        { val:"sales",       label:"Drive Sales" },
          ucContext:     { val:"Quick 30-second review format. Open with a bold first impression statement. Cover: what it is, one thing that surprised them (positive), one thing they wished was different (trust-building honesty), and why they'd still recommend it. End with a direct verdict. Fast-paced, direct, no wasted words.", label:"30-second review — honest, fast, verdict" }
        }
      },
      {
        label:  "Real Talk Hook",
        desc:   "Say the thing nobody else will say about your category. Truth as the pattern interrupt.",
        bg:     "linear-gradient(140deg,#140C04,#100A04)",
        accent: "#F59E0B",
        lbl:    "REAL TALK", hl: "Nobody talks about this.",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"viral",       label:"Viral" },
          ucGoal:        { val:"clicks",      label:"Website Clicks" },
          ucContext:     { val:"Real talk hook format: open by naming a hard truth about the category that most brands avoid saying. Build credibility through honesty and specificity. Pivot to how this brand addresses that truth differently. Close with a clear implication for the viewer. Direct, informed, slightly provocative — not aggressive.", label:"Category truth hook — say what others won't" }
        }
      },
      {
        label:  "Community Question",
        desc:   "Ask instead of sell. Engagement starts with curiosity, not a pitch.",
        bg:     "linear-gradient(140deg,#080C18,#060A14)",
        accent: "#818CF8",
        lbl:    "QUESTION", hl: "Genuine question:",
        prefill: {
          ucScriptMode:  { val:"ai",          label:"Write with AI" },
          ucAdFeeling:   { val:"friendly",    label:"Friendly" },
          ucGoal:        { val:"awareness",   label:"Brand Awareness" },
          ucContext:     { val:"Community engagement video: start with a genuine question that the target audience will have a strong opinion about — related to their lifestyle or pain point connected to the brand. Share the brand's honest perspective briefly. End by inviting comments. The goal is conversation and community, not conversion.", label:"Community question — invite dialogue, build connection" }
        }
      }
    ]
  },

  web: {
    label:  "Trending Website Concepts",
    emoji:  "🌐",
    color:  "#22D3EE",
    type:   "web",
    ideas: [
      {
        label:  "Premium SaaS Landing",
        desc:   "Dark minimal design. Clear value proposition. One conversion CTA. Nothing distracts.",
        bg:     "linear-gradient(140deg,#081A08,#0A0A0A)",
        accent: "#B7FF2A",
        lbl:    "SAAS", hl: "Build what matters.",
        prefill: {
          webType:     { val:"saas",       label:"SaaS Website" },
          webAbout:    { val:"AI-powered SaaS platform for modern businesses and teams",  label:"AI SaaS platform" },
          webGoal:     { val:"leads",      label:"Collect Leads" },
          webAudience: { val:"Startup founders, product managers, and growth teams",  label:"Startup founders, PMs" },
          webSections: { val:"Hero, Features, How it works, Testimonials, Pricing, FAQ, CTA",  label:"Hero, Features, Testimonials, Pricing, FAQ, CTA" },
          webStyle:    { val:"Minimal dark SaaS design. Near-black background with brand accent colour for CTAs. Clean grid. Strong typography hierarchy. Premium and modern.",  label:"Minimal dark SaaS, premium..." },
          _extraNotes: { val:"Conversion-first. Every section should remove a reason not to sign up. Social proof near the primary CTA.",  label:"Conversion-first, remove objections..." }
        }
      },
      {
        label:  "Luxury E-Commerce",
        desc:   "Product-first editorial grid. Shopping elevated into a premium experience.",
        bg:     "linear-gradient(140deg,#120E06,#0A0A0A)",
        accent: "#C9AA71",
        lbl:    "E-COM", hl: "Want it. Own it.",
        prefill: {
          webType:     { val:"ecommerce",  label:"E-commerce Store" },
          webAbout:    { val:"Luxury product brand with premium editorial aesthetic and exclusive positioning",  label:"Luxury product brand" },
          webGoal:     { val:"sales",      label:"Generate Sales" },
          webAudience: { val:"Premium consumers with high purchasing intent and appreciation for craft",  label:"Premium consumers" },
          webSections: { val:"Hero, Product showcase, Brand story, Featured collection, Testimonials, Contact",  label:"Hero, Products, Brand story, Collection, Testimonials" },
          webStyle:    { val:"Luxury editorial aesthetic. Dark or warm neutral palette. Full-bleed product photography. Generous whitespace. Refined serif typography. Nothing cheap.",  label:"Luxury editorial, refined typography..." },
          _extraNotes: { val:"Every element should communicate premium. Slow, deliberate design. Less is more.", label:"Every element communicates premium..." }
        }
      },
      {
        label:  "Bold Agency Portfolio",
        desc:   "Case-study centered. Results front and center. Work speaks before the team does.",
        bg:     "linear-gradient(140deg,#100C1A,#0A0A14)",
        accent: "#A78BFA",
        lbl:    "AGENCY", hl: "The work speaks.",
        prefill: {
          webType:     { val:"agency",     label:"Agency Website" },
          webAbout:    { val:"Creative or digital agency with strong portfolio and proven client results",  label:"Creative/digital agency" },
          webGoal:     { val:"book_call",  label:"Book Calls" },
          webAudience: { val:"Founders, marketing directors, and decision-makers ready to invest in growth",  label:"Founders, marketing directors" },
          webSections: { val:"Hero, Case studies, Services, Process, Team, Testimonials, Contact",  label:"Hero, Case studies, Services, Process, Testimonials, Contact" },
          webStyle:    { val:"Bold and confident design. Strong visual contrast. Large typography. Portfolio work displayed prominently. Feels like the agency uses the same creative standard it sells.",  label:"Bold, confident, portfolio-first..." },
          _extraNotes: { val:"Lead with results and work, not awards and team size. The case studies do the selling.",  label:"Results first, work leads..." }
        }
      },
      {
        label:  "AI Startup Launch Page",
        desc:   "Maximum anticipation. Futuristic aesthetic. Waitlist as the conversion goal.",
        bg:     "linear-gradient(140deg,#060E20,#040A18)",
        accent: "#3B82F6",
        lbl:    "LAUNCH", hl: "The future ships soon.",
        prefill: {
          webType:     { val:"landing",    label:"Landing Page" },
          webAbout:    { val:"AI startup or tech product launching soon — exclusive waitlist access",  label:"AI startup, pre-launch" },
          webGoal:     { val:"launch",     label:"Launch Product" },
          webAudience: { val:"Early adopters, tech enthusiasts, and founders who want first access",  label:"Early adopters, tech enthusiasts" },
          webSections: { val:"Hero, Value proposition, How it works, Early access benefits, Waitlist CTA, FAQ",  label:"Hero, Value prop, How it works, Waitlist CTA, FAQ" },
          webStyle:    { val:"Dark futuristic interface. Glowing accent colours. Animated data visualisations or UI previews. Feels like looking at something from slightly in the future.",  label:"Dark futuristic, glowing accents..." },
          _extraNotes: { val:"Build excitement and urgency. Limited early access creates desire. Show a glimpse of the product — enough to hook, not enough to satisfy.",  label:"Urgency, exclusivity, glimpse of product..." }
        }
      },
      {
        label:  "Personal Brand Hub",
        desc:   "Authority through authenticity. One person. One clear voice. A platform for ideas and work.",
        bg:     "linear-gradient(140deg,#141414,#1A1A1A)",
        accent: "#D1D5DB",
        lbl:    "PERSONAL", hl: "One voice. Many ideas.",
        prefill: {
          webType:     { val:"portfolio",  label:"Portfolio" },
          webAbout:    { val:"Personal brand website for a founder, creator, or expert building authority and audience",  label:"Personal brand, founder/creator" },
          webGoal:     { val:"trust",      label:"Build Trust" },
          webAudience: { val:"Potential collaborators, clients, followers, and media looking to understand who this person is",  label:"Collaborators, clients, followers" },
          webSections: { val:"Hero, About, Work or ideas, Featured content, Speaking or press, Contact",  label:"Hero, About, Work, Content, Contact" },
          webStyle:    { val:"Clean, minimal design. Typography-forward. Strong portrait photography. Personal and warm but polished. Feels like a sophisticated personal website, not a corporate brand.",  label:"Clean, typography-forward, warm..." },
          _extraNotes: { val:"Voice and personality over perfection. The person IS the brand. Let that come through in the writing and the design choices.",  label:"Voice over perfection..." }
        }
      },
      {
        label:  "Clean B2B Service Site",
        desc:   "Enterprise trust signals. Process clarity. Results that make the decision easy.",
        bg:     "linear-gradient(140deg,#060A12,#080C18)",
        accent: "#818CF8",
        lbl:    "B2B", hl: "Results, clearly stated.",
        prefill: {
          webType:     { val:"business",   label:"Business Website" },
          webAbout:    { val:"B2B service business serving enterprise or mid-market clients",  label:"B2B service business" },
          webGoal:     { val:"book_call",  label:"Book Calls" },
          webAudience: { val:"Decision-makers, procurement teams, and C-suite buyers evaluating vendors",  label:"B2B decision-makers, buyers" },
          webSections: { val:"Hero, Services, How we work, Results and case studies, Client logos, Team, Book a call",  label:"Hero, Services, Process, Results, Team, CTA" },
          webStyle:    { val:"Professional and clean. Light or dark neutral palette. Structured and easy to navigate. Every section removes a reason not to trust. Polished but not flashy.",  label:"Professional, clean, trust-first..." },
          _extraNotes: { val:"Trust signals on every page. Specific results over vague claims. Make the buying decision feel low risk.",  label:"Trust signals, specific results..." }
        }
      },
      {
        label:  "Startup Landing Page",
        desc:   "Everything a startup needs to communicate traction, vision, and why now — in one tight page.",
        bg:     "linear-gradient(140deg,#06101E,#040C16)",
        accent: "#60A5FA",
        lbl:    "STARTUP", hl: "We're solving this.",
        prefill: {
          webType:     { val:"landing",    label:"Landing Page" },
          webAbout:    { val:"Early-stage startup solving a real problem in a defined market",  label:"Early-stage startup" },
          webGoal:     { val:"leads",      label:"Collect Leads" },
          webAudience: { val:"Potential early adopters, investors, and partners evaluating whether to get involved",  label:"Early adopters, investors, partners" },
          webSections: { val:"Hero with bold problem statement, Solution, How it works, Team credibility, Traction metrics, CTA",  label:"Problem, Solution, How it works, Team, Traction, CTA" },
          webStyle:    { val:"Clean, modern, slightly scrappy energy that signals movement and conviction. Strong on the problem statement. Numbers and traction signals prominent. Team faces build trust.",  label:"Modern, conviction-forward, traction-visible..." },
          _extraNotes: { val:"Lead with the problem — make it undeniable. Traction signals (users, revenue, waitlist size) should be prominent above the fold. Don't hide behind vague language.",  label:"Problem-first, traction visible..." }
        }
      },
      {
        label:  "Waitlist Page",
        desc:   "Maximum intrigue, minimum information. Create desire before the product even ships.",
        bg:     "linear-gradient(140deg,#0A041A,#080318)",
        accent: "#A78BFA",
        lbl:    "WAITLIST", hl: "Not available yet.",
        prefill: {
          webType:     { val:"landing",    label:"Landing Page" },
          webAbout:    { val:"Unreleased product or service building pre-launch demand through a waitlist",  label:"Pre-launch waitlist" },
          webGoal:     { val:"launch",     label:"Launch Product" },
          webAudience: { val:"Early adopters and forward-thinking buyers who want to be first",  label:"Early adopters, first movers" },
          webSections: { val:"Hero with waitlist CTA, Value teaser, Social proof counter, Benefits preview, FAQ",  label:"Hero, Value teaser, Proof counter, Benefits, FAQ" },
          webStyle:    { val:"Dark, exclusive, mysterious energy. Deliberately limited information creates desire. Counter showing waitlist size builds FOMO. Feels like something that isn't for everyone.",  label:"Dark, exclusive, deliberately limited..." },
          _extraNotes: { val:"Don't reveal too much — scarcity of information creates desire. Show the waitlist number growing. Make being on the list feel like an achievement, not just an email capture.",  label:"Withhold to create desire, waitlist as status..." }
        }
      },
      {
        label:  "Event Website",
        desc:   "The event experience starts here. Build anticipation before anyone arrives.",
        bg:     "linear-gradient(140deg,#100A00,#0A0A0A)",
        accent: "#FCD34D",
        lbl:    "EVENT", hl: "You need to be there.",
        prefill: {
          webType:     { val:"landing",    label:"Landing Page" },
          webAbout:    { val:"In-person or virtual event — conference, launch party, workshop, or experience",  label:"Event or conference" },
          webGoal:     { val:"sales",      label:"Generate Sales" },
          webAudience: { val:"Potential attendees evaluating whether this event is worth their time and money",  label:"Potential attendees" },
          webSections: { val:"Hero with date and location, What to expect, Speakers or lineup, Agenda preview, Past event testimonials, Ticket tiers, FAQ",  label:"Hero, Experience, Lineup, Agenda, Testimonials, Tickets, FAQ" },
          webStyle:    { val:"Energetic and anticipatory. Strong photography of past events or speaker portraits. Clear date, location, and ticket CTA above the fold. Countdown element creates real urgency.",  label:"Energetic, anticipatory, countdown urgency..." },
          _extraNotes: { val:"FOMO must be felt immediately. Past event photos or speaker portraits are the strongest trust signal. Countdown to the date creates genuine urgency.",  label:"FOMO above fold, countdown urgency..." }
        }
      },
      {
        label:  "Coaching & Consulting Site",
        desc:   "Authority and process. Show the transformation, not just the service.",
        bg:     "linear-gradient(140deg,#0C0C08,#0A0A0A)",
        accent: "#D4A574",
        lbl:    "COACHING", hl: "Results, not theory.",
        prefill: {
          webType:     { val:"business",   label:"Business Website" },
          webAbout:    { val:"Coaching or consulting practice — one-to-one or group transformation service",  label:"Coaching or consulting practice" },
          webGoal:     { val:"book_call",  label:"Book Calls" },
          webAudience: { val:"High-achieving individuals or businesses who know they need external expertise to get to the next level",  label:"Ambitious clients ready to invest" },
          webSections: { val:"Hero with outcome statement, Who this is for, The process, Results and case studies, About the coach, Testimonials, Book a call CTA",  label:"Hero, Who it's for, Process, Results, About, Testimonials, CTA" },
          webStyle:    { val:"Professional warmth. Strong portrait photography. Outcome language throughout — specific transformation results. Process section builds confidence. Trust through specificity.",  label:"Professional warmth, outcome-led, specific results..." },
          _extraNotes: { val:"Lead with the outcome, not the modality. 'I help X achieve Y in Z timeframe' beats 'I offer coaching services'. Testimonials with specific results are the strongest conversion driver.",  label:"Outcome-led, transformation-first..." }
        }
      },
      {
        label:  "Restaurant & Hospitality",
        desc:   "Atmosphere first. The feeling of being there begins at the first scroll.",
        bg:     "linear-gradient(140deg,#140A00,#100800)",
        accent: "#F59E0B",
        lbl:    "HOSPITALITY", hl: "Feel it before you arrive.",
        prefill: {
          webType:     { val:"business",   label:"Business Website" },
          webAbout:    { val:"Restaurant, café, hotel, or hospitality venue — selling an experience as much as a service",  label:"Restaurant or hospitality venue" },
          webGoal:     { val:"sales",      label:"Generate Sales" },
          webAudience: { val:"Food lovers, experience seekers, and local diners making a reservation decision",  label:"Experience-driven diners, local visitors" },
          webSections: { val:"Hero with atmosphere photography, Menu preview, Story and chef, Gallery, Reservations, Location and hours",  label:"Hero, Menu, Story, Gallery, Reservations, Location" },
          webStyle:    { val:"Immersive, sensory, atmosphere-first. Rich food and interior photography. Warm colour temperature. Typography matching the venue aesthetic. Every image should make the viewer feel the experience.",  label:"Immersive, sensory, atmosphere-first..." },
          _extraNotes: { val:"Atmosphere images beat food images for emotional pull. Show the room, the light, the people enjoying it — then show the food. Make the reservation feel easy and immediate.",  label:"Atmosphere first, then food, easy reservation..." }
        }
      },
      {
        label:  "Non-Profit & Impact",
        desc:   "Mission-led design. Show the change you're making before asking for support.",
        bg:     "linear-gradient(140deg,#040E0A,#040A06)",
        accent: "#34D399",
        lbl:    "IMPACT", hl: "The change is real.",
        prefill: {
          webType:     { val:"business",   label:"Business Website" },
          webAbout:    { val:"Non-profit, charity, or social impact organisation driving measurable change",  label:"Non-profit or impact organisation" },
          webGoal:     { val:"trust",      label:"Build Trust" },
          webAudience: { val:"Donors, volunteers, and supporters who need to believe the mission is real and the impact is measurable",  label:"Donors, volunteers, mission-aligned supporters" },
          webSections: { val:"Hero with impact statement, The problem, Our work and approach, Real impact metrics, Stories and testimonials, How to support, Team and partners",  label:"Hero, Problem, Approach, Impact, Stories, Support, Team" },
          webStyle:    { val:"Human, documentary, earnest. Real photography of real people and real situations. Impact numbers prominent. No stock photography. Feels like a movement, not a marketing campaign.",  label:"Human, documentary, real people, impact-visible..." },
          _extraNotes: { val:"Lead with impact metrics — make the change undeniable in numbers. Then make it human through stories. Every donation page should show exactly what a specific amount achieves.",  label:"Impact-first, numbers then stories..." }
        }
      }
    ]
  },

  text: {
    label:  "Trending Copy & Hooks",
    emoji:  "✍️",
    color:  "#B7FF2A",
    type:   "text",
    ideas: [
      {
        label:  "Product Launch Post",
        desc:   "Announcement energy. Build excitement in the opening line. The product earns the spotlight.",
        bg:     "linear-gradient(140deg,#160833,#0A0A0A)",
        accent: "#C084FC",
        lbl:    "LAUNCH", hl: "It's finally here.",
        prefill: {
          txtType:      { val:"caption",   label:"Social Caption" },
          txtPurpose:   { val:"launch",    label:"Product Launch" },
          txtObjective: { val:"announce",  label:"Announce" },
          txtCtaStyle:  { val:"urgency",   label:"Urgency" },
          _extraNotes:  { val:"Instagram product launch announcement. Premium, exciting tone. Open with the moment, not the product name. End with a clear CTA.",  label:"Instagram launch — open with the moment..." }
        }
      },
      {
        label:  "High-Converting Hook",
        desc:   "Pattern interrupt. Stop the scroll in the first word. Make them read the second sentence.",
        bg:     "linear-gradient(140deg,#1C0A1C,#0A0A0A)",
        accent: "#E879F9",
        lbl:    "HOOK", hl: "They stopped. Now what?",
        prefill: {
          txtType:      { val:"hook",       label:"Hook" },
          txtPurpose:   { val:"engagement", label:"Engage Audience" },
          txtObjective: { val:"engage",     label:"Engage" },
          txtCtaStyle:  { val:"soft",       label:"Soft Nudge" },
          _extraNotes:  { val:"Pattern-interrupt hook for social media. Must land in 2-3 seconds. Use a bold claim, provocative question, or surprising fact. Every word earns its place.", label:"Pattern interrupt — 2-3 seconds..." }
        }
      },
      {
        label:  "Authority Statement",
        desc:   "Confident positioning that earns trust without asking for it. Leadership through language.",
        bg:     "linear-gradient(140deg,#120E04,#0A0A0A)",
        accent: "#C9AA71",
        lbl:    "AUTHORITY", hl: "In a class of one.",
        prefill: {
          txtType:      { val:"body_copy",  label:"Body Copy" },
          txtPurpose:   { val:"awareness",  label:"Build Awareness" },
          txtObjective: { val:"inspire",    label:"Inspire" },
          txtCtaStyle:  { val:"none",       label:"No CTA" },
          _extraNotes:  { val:"Premium positioning copy that frames the brand above the competition without ever naming them. Confidence without aggression. Should make the reader feel they're engaging with a category leader.",  label:"Premium positioning, category leader..." }
        }
      },
      {
        label:  "Emotional Brand Story",
        desc:   "Move people before you sell to them. Narrative first, product second. Connection before conversion.",
        bg:     "linear-gradient(140deg,#200A0A,#0A0A0A)",
        accent: "#F87171",
        lbl:    "STORY", hl: "Feel it first.",
        prefill: {
          txtType:      { val:"body_copy",  label:"Body Copy" },
          txtPurpose:   { val:"brand_intro",label:"Brand Introduction" },
          txtObjective: { val:"inspire",    label:"Inspire" },
          txtCtaStyle:  { val:"soft",       label:"Soft Nudge" },
          _extraNotes:  { val:"Emotional brand story — open in the middle of something that matters, build to the founding moment, close with what it means for the audience. No product pitch until the very end, if at all.",  label:"Open in the middle of something that matters..." }
        }
      },
      {
        label:  "Conversion-First Ad Copy",
        desc:   "Every word drives one action. No fluff, no decoration. Remove friction. Close.",
        bg:     "linear-gradient(140deg,#081606,#0A0A0A)",
        accent: "#B7FF2A",
        lbl:    "CONVERT", hl: "One action. Now.",
        prefill: {
          txtType:      { val:"ad_copy",    label:"Ad Copy" },
          txtPurpose:   { val:"conversion", label:"Drive Conversions" },
          txtObjective: { val:"convert",    label:"Convert" },
          txtCtaStyle:  { val:"urgency",    label:"Urgency" },
          _extraNotes:  { val:"Conversion-first ad copy: headline (max 8 words, benefit-led), primary text (2-3 sentences removing every reason not to buy), CTA (max 4 words, direct action). Zero fluff.",  label:"Headline + primary text + CTA, zero fluff..." }
        }
      },
      {
        label:  "Aspirational Brand Tagline",
        desc:   "The brand promise in one line. True, memorable, resonant for years — not just for launch.",
        bg:     "linear-gradient(140deg,#06101C,#080C18)",
        accent: "#60A5FA",
        lbl:    "TAGLINE", hl: "One line. Everything.",
        prefill: {
          txtType:      { val:"headline",   label:"Headline" },
          txtPurpose:   { val:"brand_intro",label:"Brand Introduction" },
          txtObjective: { val:"inspire",    label:"Inspire" },
          txtCtaStyle:  { val:"none",       label:"No CTA" },
          _extraNotes:  { val:"Brand tagline — compress the entire brand promise into one line. Should feel true, aspirational, and memorable. Tested against: could you say this in 10 years? Would the founder be proud to live up to it?",  label:"One-line brand promise, memorable for years..." }
        }
      },
      {
        label:  "Launch Post",
        desc:   "The social post that announces something real. Excitement without cringe. Momentum without oversell.",
        bg:     "linear-gradient(140deg,#0A1208,#080E06)",
        accent: "#B7FF2A",
        lbl:    "LAUNCH POST", hl: "This is the moment.",
        prefill: {
          txtType:      { val:"caption",    label:"Social Caption" },
          txtPurpose:   { val:"launch",     label:"Product Launch" },
          txtObjective: { val:"announce",   label:"Announce" },
          txtCtaStyle:  { val:"urgency",    label:"Urgency" },
          _extraNotes:  { val:"Launch post for a new product or feature. Opens with the moment of arrival — not the product name. Builds briefly on why this matters and who it's for. Clean CTA. Avoids overused phrases like 'excited to announce'. Should feel like genuine excitement, not a press release.",  label:"Launch post — genuine excitement, no 'excited to announce'..." }
        }
      },
      {
        label:  "Founder Story Post",
        desc:   "The personal narrative that makes people root for you — before they ever buy anything.",
        bg:     "linear-gradient(140deg,#180A06,#100804)",
        accent: "#F97316",
        lbl:    "FOUNDER STORY", hl: "Why I started.",
        prefill: {
          txtType:      { val:"body_copy",  label:"Body Copy" },
          txtPurpose:   { val:"brand_intro",label:"Brand Introduction" },
          txtObjective: { val:"inspire",    label:"Inspire" },
          txtCtaStyle:  { val:"soft",       label:"Soft Nudge" },
          _extraNotes:  { val:"Founder story for social media (LinkedIn or Instagram). Open in the middle of a real moment — not 'I always dreamed of starting a business'. Include: one thing harder than expected, one surprise, and what they've learned so far. Authentic, specific, a little vulnerable. Ends with a human invite — not a sales pitch.",  label:"Founder story — open in a real moment, vulnerable, specific..." }
        }
      },
      {
        label:  "Sales Announcement",
        desc:   "The news-style post that makes a sale feel like an event, not a discount.",
        bg:     "linear-gradient(140deg,#1A0408,#100408)",
        accent: "#F43F5E",
        lbl:    "SALE", hl: "Now is the time.",
        prefill: {
          txtType:      { val:"caption",    label:"Social Caption" },
          txtPurpose:   { val:"conversion", label:"Drive Conversions" },
          txtObjective: { val:"convert",    label:"Convert" },
          txtCtaStyle:  { val:"urgency",    label:"Urgency" },
          _extraNotes:  { val:"Sales announcement post. Lead with the offer value, not the percentage. Frame it as a moment, not a clearance. Include: what's included, the end date, and one sentence on why now is the right time. Direct link CTA. No hollow excitement words — let the offer speak.",  label:"Sale as event, offer value over %, direct CTA..." }
        }
      },
      {
        label:  "Product Description",
        desc:   "Benefits-led, sensory, and specific. Copy that makes the product feel real before purchase.",
        bg:     "linear-gradient(140deg,#08080C,#0A0A0E)",
        accent: "#818CF8",
        lbl:    "PRODUCT", hl: "Here's what it does.",
        prefill: {
          txtType:      { val:"body_copy",  label:"Body Copy" },
          txtPurpose:   { val:"conversion", label:"Drive Conversions" },
          txtObjective: { val:"convert",    label:"Convert" },
          txtCtaStyle:  { val:"soft",       label:"Soft Nudge" },
          _extraNotes:  { val:"E-commerce or website product description. Leads with the primary benefit in the first sentence. Uses sensory and specific language — not 'high quality' but what high quality feels like. Covers: what it does, who it's for, and what makes it different. Short paragraphs for scannability. Ends with confidence.",  label:"Benefits-first, sensory, specific — no generic quality claims..." }
        }
      },
      {
        label:  "Email Introduction",
        desc:   "The first email that sets the relationship — warm, clear, and impossible to ignore.",
        bg:     "linear-gradient(140deg,#040C18,#040A14)",
        accent: "#38BDF8",
        lbl:    "EMAIL INTRO", hl: "Hello from us.",
        prefill: {
          txtType:      { val:"body_copy",  label:"Body Copy" },
          txtPurpose:   { val:"brand_intro",label:"Brand Introduction" },
          txtObjective: { val:"inspire",    label:"Inspire" },
          txtCtaStyle:  { val:"soft",       label:"Soft Nudge" },
          _extraNotes:  { val:"Welcome or introduction email for a new subscriber or customer. Opens with one genuine line of thanks (not generic). Briefly explains what they'll receive and why it's worth reading. Shares one thing about the brand that most people don't know. Single CTA at the end. Short, warm, brand-consistent voice throughout.",  label:"Welcome email — genuine, exclusive detail, single CTA..." }
        }
      },
      {
        label:  "Community Engagement Post",
        desc:   "A post that invites your audience into a conversation — not a broadcast.",
        bg:     "linear-gradient(140deg,#0A1208,#080E08)",
        accent: "#4ADE80",
        lbl:    "COMMUNITY", hl: "Tell me what you think.",
        prefill: {
          txtType:      { val:"caption",    label:"Social Caption" },
          txtPurpose:   { val:"engagement", label:"Engage Audience" },
          txtObjective: { val:"engage",     label:"Engage" },
          txtCtaStyle:  { val:"soft",       label:"Soft Nudge" },
          _extraNotes:  { val:"Community engagement post for social media. Opens with a genuine observation or question related to the audience's world — not the brand. Shares the brand's honest take in 2-3 sentences. Invites the reader to share theirs with a specific, easy-to-answer prompt. Feels like a conversation starter, not content strategy. Comment-worthy over like-worthy.",  label:"Conversation starter — opinion, invite reply, comment-worthy..." }
        }
      }
    ]
  }

};

// ── State ─────────────────────────────────────────────────────────
var _inspCurrentFilter = "campaign";

// ── Render inspiration hub ────────────────────────────────────────
// Overrides the studio.js version loaded earlier.
function renderInspiration(){
  var feed = document.getElementById("idFeed");
  if(!feed) return;

  var cats = [_inspCurrentFilter];
  var html = "";
  var totalCards = 0;

  cats.forEach(function(cat){
    var section = INSP_DATA[cat];
    if(!section || !section.ideas || !section.ideas.length) return;

    html += '<div class="id-section" data-cat="' + cat + '">';

    // Section header
    html += '<div class="id-section-hdr">'
      + '<span class="id-section-emoji">' + section.emoji + '</span>'
      + '<span class="id-section-lbl" style="color:' + section.color + '">' + section.label + '</span>'
      + '</div>';

    // Card grid
    html += '<div class="id-section-grid">';
    section.ideas.forEach(function(idea, idx){
      totalCards++;
      html += '<div class="id-concept-card" onclick="idUseConcept(\'' + cat + '\',' + idx + ')">';

      // Thumbnail
      html += '<div class="id-card-thumb" style="background:' + idea.bg + '">'
        + '<div class="id-thumb-glow" style="background:' + idea.accent + '"></div>'
        + '<div class="id-thumb-lbl">' + idea.lbl + '</div>'
        + '<div class="id-thumb-hl">' + idea.hl + '</div>'
        + '</div>';

      // Body
      html += '<div class="id-card-body">'
        + '<div class="id-card-cat" style="color:' + section.color + '">'
        + section.label.replace('Trending ','')
        + '</div>'
        + '<div class="id-card-title">' + idea.label + '</div>'
        + '<div class="id-card-desc">' + idea.desc + '</div>'
        + '<button class="id-card-cta">Use This Inspiration</button>'
        + '</div>';

      html += '</div>';
    });
    html += '</div>'; // /id-section-grid
    html += '</div>'; // /id-section
  });

  feed.innerHTML = html;

  // Update curation note
  var ct = document.getElementById("idCurationText");
  if(ct) ct.textContent = totalCards + " curated starting points — pre-filled and ready to generate.";
}

// ── Filter handler ────────────────────────────────────────────────
// Overrides studio.js version.
function idFilter(cat, btn){
  _inspCurrentFilter = cat;
  document.querySelectorAll(".id-filt").forEach(function(b){ b.classList.remove("id-filt-active"); });
  if(btn) btn.classList.add("id-filt-active");
  renderInspiration();
}

// ── Main dispatch: use an inspiration card ────────────────────────
// For non-UGC: seeds _cfAnswers + shows brief overlay → _cfDispatch()
// For UGC:     opens openAIFlow with pre-seeded answers (avatar/voice still required)
function idUseConcept(cat, idx){
  var section = INSP_DATA[cat];
  if(!section) return;
  var idea = section.ideas[idx];
  if(!idea) return;

  var type    = section.type;
  var prefill = idea.prefill;

  if(type === "ugc"){
    // UGC: open the AI conversation flow with answers pre-seeded.
    // The avatar-picker and voice-picker steps still show (user must choose).
    // All other steps (scriptMode, feeling, goal, context) auto-advance.
    openAIFlow("ugc", prefill);
    return;
  }

  // Non-UGC: seed _cfAnswers directly and dispatch immediately.
  // This bypasses the conversation and generates straight from the prefill.
  _cfType    = type;
  _cfAnswers = {};
  Object.keys(prefill).forEach(function(key){
    _cfAnswers[key] = prefill[key];
  });

  // Show the CF overlay briefly ("Building your X…") then dispatch
  var meta   = (typeof CF_META !== "undefined" && CF_META[type]) || { label: type, icon: "" };
  var iconEl = document.getElementById("cfTypeIcon");
  var lblEl  = document.getElementById("cfTypeLabel");
  var fillEl = document.getElementById("cfProgressFill");
  var histEl = document.getElementById("cfHistory");
  var optsEl = document.getElementById("cfOptions");
  var freeEl = document.getElementById("cfFreeInput");
  var qEl    = document.getElementById("cfQuestionText");
  var dEl    = document.getElementById("cfQuestionDesc");
  var block  = document.getElementById("cfQuestionBlock");

  if(iconEl && meta.icon) iconEl.innerHTML = meta.icon;
  if(lblEl)  lblEl.textContent  = meta.label;
  if(fillEl) fillEl.style.width = "100%";
  if(histEl) histEl.innerHTML   = "";
  if(optsEl){ optsEl.innerHTML  = ""; optsEl.style.opacity = "1"; }
  if(freeEl)  freeEl.style.display = "none";
  if(qEl)    qEl.textContent    = "Building your " + meta.label + "…";
  if(dEl)    dEl.textContent    = "Inspiration applied. BrandCore injected. Sending to AI…";

  if(block){
    block.style.transition = "none";
    block.style.opacity    = "1";
    block.style.transform  = "translateY(0)";
  }

  // Open the overlay
  var overlay = document.getElementById("cfOverlay");
  if(overlay){
    overlay.style.display    = "flex";
    overlay.style.opacity    = "0";
    overlay.style.transition = "none";
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        overlay.style.transition = "opacity 0.22s ease";
        overlay.style.opacity    = "1";
      });
    });
  }

  // After a brief pause, close overlay and dispatch generation
  setTimeout(function(){
    if(overlay){
      overlay.style.transition = "opacity 0.2s ease";
      overlay.style.opacity    = "0";
      setTimeout(function(){ overlay.style.display = "none"; }, 220);
    }
    // _cfDispatch reads _cfType + _cfAnswers and calls navigate("builder") + _flowGenerate()
    if(typeof _cfDispatch === "function") _cfDispatch();
  }, 700);
}

// ── idShowHub — panel back button handler ─────────────────────────
function idShowHub(){
  var hub   = document.getElementById("idHubView");
  var panel = document.getElementById("idPanelView");
  if(hub)   hub.classList.remove("hidden");
  if(panel) panel.classList.add("hidden");
}
