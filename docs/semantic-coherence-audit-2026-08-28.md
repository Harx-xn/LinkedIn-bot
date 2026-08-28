# Veyrais Semantic-Coherence Architecture Audit

Date: 2026-08-28  
Scope: manual and batch generation; investigation only. No production behavior was changed.

## A. Executive Summary

The observed post is a batch-generation failure with a confirmed database and generation-trace record. It was not created by the manual-post frontend or by a stale displayed value.

The earliest corruption occurred during search-result classification. A legitimate research paper about applying *Magic: The Gathering* game-design principles to mHealth was returned for the Unity query `Unity game design principles research`. The source is internally coherent as an intentional cross-domain paper, but it is not evidence that the subject belongs to a Unity-development pillar or naturally serves Indie Game Developers. `buildActiveNicheEvidence` nevertheless accepted broad category evidence (`game design`) plus context inherited from the originating query, assigned the first active pillar (`Unity Game Development`), and `scoreTrendForStrategy` awarded a perfect 100 relevance score even though audience, goal, and positioning evidence were all zero.

The resulting candidate already combined an mHealth claim, Unity pillar, `design-principles` territory, and a game-developer playbook idea family before the writer ran. Admission and coherence scoring evaluated field-to-profile similarities independently; they did not validate the directional relationship among topic, audience, mechanism, source, and conclusion. A high creator/pillar score masked audience naturalness of 26. The writer then saw the mHealth claim together with the global configured audience `Indie Game Devs`. Although the slot-level audience was empty and the prompt said not to insert a configured label, it inserted that audience. The reviewer returned no issues, so no repair or fallback ran for this post.

Classification: **confirmed search/classification contamination, confirmed candidate-generation/frame failure, confirmed reviewer failure, and a writer contribution**. There is no evidence that fields from two candidate objects, an array ordering bug, fallback, or cross-request cache leak caused this exact incident.

## B. Complete Generation Path

### Manual generation

| Stage | File / function | Input → output and transformation | Validation | New concepts? / driver |
|---|---|---|---|---|
| HTTP entry | `src/routes/manualPosts.ts:202` | Request body → cost-scoped call to `generateManualPostContent` | Route/auth/entitlement | No / deterministic |
| Input and context | `manualPost/manualPostOrchestration.ts:216` `generateManualPostV2` | User topic, instructions, context, optional experience → normalized input, voice, recent posts/fingerprints, authority context | Length/input schemas, entitlement, experience ownership | User/profile concepts only / deterministic + DB |
| Authority | `userKnowledgeAuthorityService.ts:351` | Profile, manual posts, selected experience, niche → authority modes and boundaries | First-person evidence boundaries | Does not create subject relationships / deterministic |
| Planner | `manualPost/manualPostMultiStage.ts:227`; `manualPostPrompts.ts:264` | Topic/context/profile → several structured plans | `selectManualPlan` schema and topic/fact preservation; one retry | Yes / LLM |
| Planner fallback | `manualPostPlanning.ts:543` | Original topic + expression mode + author → deterministic selected plan | Structural construction only | Can use global audience independently / deterministic |
| Draft writer | `manualPostMultiStage.ts:286`; `manualPostPrompts.ts:327` | Selected plan + topic + author + voice + evidence → structured post | JSON/schema parsing | Yes / LLM |
| Critic | `manualPostCritic.ts:14` | Draft text → genericness, progression, repetition and related quality issues | No semantic-frame tuple invariant | No / deterministic |
| Repair/recovery | `manualPostMultiStage.ts:346,393`; `manualPostPrompts.ts:411` | Same selected plan + draft + issue list → repaired draft | Length, requested issue resolution, preserved facts | Wording/depth changes; plan is preserved / LLM |
| Candidate retention | `manualPostMultiStage.ts:90,436` | Initial/repair/recovery drafts → best hard-usable draft | ≤3,000 chars; warning count/length score | No / deterministic |
| Finalization | `manualPostOrchestration.ts:305+` | Draft → final body/hashtags/media recommendation | Max length and personal-experience number boundary | Formatting only / deterministic |

Manual generation is isolated from the batch candidate/search/coherence pipeline. Its topic comes directly from the user, so it could still accept an incoherent planner tuple, but it did not produce the observed post.

### Batch generation

| Stage | File / function | Input → output and transformation | Validation | New concepts? / driver |
|---|---|---|---|---|
| Batch entry | `trendingBotService.ts:83,461` | User/bot config + requested count → generation context | Entitlement/config requirements | No / deterministic |
| Strategy/authority | `ghostwriterPipeline.ts:118,169` | Effective strategy, voice, niches, knowledge → author/content-intelligence/authority context | Authority boundaries only | Profile concepts / deterministic + DB |
| Strategy candidates | `ghostwriterPipeline.ts:118+` and semantic idea services | Pillars/territories/audience model → structured strategy candidates | Schema/idea critic, novelty, authority and quality scores | Yes / LLM with deterministic fallback |
| Niche expansion/query | `trendOrchestrationService.ts:132,200+`; `nicheExpansionService.ts` | Each niche/profile → validated source queries | Query specificity/domain/exclusion rules | Yes / LLM + deterministic |
| Search retrieval/cache | `trendsService.ts:572+`; `trendFetchCache.ts:39,87` | Query/source/freshness → raw source results | Provider parsing/deduplication | Source concepts / external data |
| Niche evidence | `botStrategyTrendService.ts:104` | Source text + query context + expansion profile → matched category/pillar/evidence | Lexical evidence rules | Assigns domain metadata / deterministic |
| Strategy score | `botStrategyTrendService.ts:474` | Candidate + strategy/profile/history → relevance breakdown and niche match | Thresholds, exclusions | No, but can legitimize a bad mapping / deterministic |
| Search admission | `searchCandidateAdmissionService.ts:79` | Source + scores/profile → creator fit, audience naturalness, transformability, disposition | Independent weighted thresholds | No / deterministic |
| Fingerprint/rank | `trendSelectionService.ts:445+`; `topicFingerprintService.ts:138+` | Admitted source → fingerprinted ranked candidate | Novelty/history/source quality | May LLM-classify fingerprint / mixed |
| Unified normalization | `unifiedBatchCandidateService.ts:143+` | Ranked candidate → normalized candidate + coherence | Critical-code and novelty gates | No / deterministic |
| Unified selection/enrichment | `unifiedBatchCandidateService.ts:300+`, `:436+` | Strategy/search/inventory candidates → selected candidates; evidence-only sources may attach | Ranking, memory, collisions | Source metadata can be attached / deterministic |
| Editorial plan | `ghostwriterBatchPlanner.ts:42,63`; `editorialDecisionService.ts` | Selected candidates by index → claim/depth/editorial plan | Form diversity only | Editorial form, not subject matter / deterministic, then LLM claim narrowing |
| Claim narrowing | `ghostwriterPipeline.ts:673+` via `contentService.narrowBatchClaims` | Base plan + same trends → narrowed plan | Claim schema/diversity | Can rephrase/select claim / LLM |
| Writer prompt | `ghostwriterPrompts.ts:50+,196,250` | Author/global strategy + slot plan + source → prompt | Prompt contracts only | Writer may synthesize/hallucinate / LLM |
| Writer output | `ghostwriterGenerationService.ts:564+` | Prompt → structured draft | JSON parsing | Yes / LLM |
| Deterministic validation | `ghostwriterValidationService.ts:306` | Draft + plan + prior bodies/history → issues/score | Length, authority, specificity, technical patterns, progression, ending, hashtags, duplication/fingerprints | No / deterministic |
| Technical review | `ghostwriterGenerationService.ts:256`; `contentService.ts:751` | Draft + author + plan → semantic-quality scores/issues | Reviewer prompt; no mandatory tuple check | Reviewer can identify issues / LLM |
| Repair/retry | `ghostwriterGenerationService.ts:655,779,795` | Same plan + draft + issues → repaired/regenerated candidates | Same gates | Cannot replace the idea contract / LLM |
| Idea recovery/fallback | `ghostwriterGenerationService.ts:880+` | Failed idea → alternate idea, best usable candidate, then bounded safe writer fallback | Critical issue filters and hard platform/authority gates | Alternate or template content / mixed |
| Persistence | `trendingBotService.ts:550+,812+` | Accepted slot result → post, fingerprint, history, trace | Collision/finalization checks | No / deterministic + DB |

## C. Concept Provenance

| Concept | Possible origins inspected | Actual origin in this incident | Actual code path | Confidence |
|---|---|---|---|---|
| `mHealth` | Topic, source, semantic idea, writer | Exact external source title and source body | Unity research query → Google/source result → `TrendCandidate.topic` → selected claim | Confirmed |
| `M.A.G.I.C.` | Source, enrichment, writer hallucination | Exact external source title/framework | Same source → claim contract → writer | Confirmed |
| `Indie Game Developers` | Target audience, pillar audience relevance, idea family, writer | Configured primary audience (`Indie Game Devs`) and pre-writer candidate idea family; writer rendered the expanded label in prose | Strategy/author block and candidate idea family → writer | Confirmed for profile/idea-family provenance; highly likely writer expansion to full wording |
| `GameDevelopment` | Niche, pillar, search query, writer hashtag | `Unity Game Development` configured niche/pillar; source also contains game-design language | Classification assigns pillar → plan/global strategy → writer hashtag | Confirmed |

The paper’s `mHealth ↔ M.A.G.I.C. ↔ game-design principles` relationship was intentional. The invalid step was treating that paper as creator-native Unity content and binding it to an Indie Game Developer content frame without making “what game developers can learn from mHealth research” the explicit selected thesis.

## D. First Point of Semantic Corruption

The first corrupt transformation was `buildActiveNicheEvidence` in `botStrategyTrendService.ts:104–157`:

1. The source matched the broad category `game design`.
2. Its originating query supplied Unity/game-development context.
3. `category_plus_context` was accepted as pillar satisfaction.
4. With no literal/keyword pillar match, the function used `activePillars[0]` and labeled the candidate `Unity Game Development`.

`scoreTrendForStrategy` then produced 100 from direct niche evidence (40), pillar (40), and category (20), while audience, goals, and positioning each contributed zero. At this point the raw paper was no longer merely a cross-domain source; it had become a Unity candidate without a proven creator/audience relationship.

The trace shows the selected candidate before writing had:

- topic: `mHealth development`
- pillar: `Unity Game Development`
- territory: `design-principles`
- idea family: `A practical Unity Game Development playbook for Indie Game Devs`
- resolved audience: `[]`
- audience naturalness: `26`
- creator fit: `95`

## E. Why Existing Layers Did Not Catch It

1. **Query validation** checked that the query described the niche, not that every returned result preserved that domain.
2. **Niche evidence** treated category plus originating-query context as sufficient and defaulted to the first pillar.
3. **Strategy scoring** was additive. Strong category/pillar evidence could reach 100 with no audience or positioning relationship.
4. **Search admission** scored source transformability, creator fit, and audience naturalness independently. It requires creator fit/overall thresholds but no topic-to-audience or source-domain-to-pillar relation.
5. **Candidate coherence** combines scalar subscores. Its main no-relationship rejection requires creator ≤25, audience ≤25, and pillar ≤55 simultaneously. Inflated creator/pillar scores masked audience 26.
6. **Unified selection** saw no critical rejection code; quality and novelty outweighed a one-point coherence penalty.
7. **Editorial decision** classified form signals (`framework`, explanatory progression, reference value) independently. It made the candidate look structurally healthy without validating the semantic tuple.
8. **Authority** correctly prevented unsupported personal experience but did not ask whether the claim belonged to the chosen audience/domain.
9. **Writer prompt** contained both the contaminated mHealth claim and global Indie Game Dev audience context.
10. **Deterministic validation** checked prose/format/authority/duplication, not semantic-frame consistency.
11. **LLM reviewer** was capable of reporting audience/claim drift in principle, but returned `passed`, no issue codes, claim fidelity 90, and deterministic score 100.
12. **Repair/fallback** did not run for this post because it was accepted on the initial draft.

## F. Candidate Integrity Findings

No candidate-merging failure was found for this incident. The source title, source URL, topic fingerprint, selected claim, and final history all point to one candidate ID (`029a68a0dad12574`) and one batch slot.

Findings and risks:

- `TrendCandidate` is a bag of optional strings and scores (`generationTypes.ts:92+`). It has provenance fields, but they are optional for legacy/stored candidates and there is no semantic-frame identity tying all fields together.
- `trendSelectionService.ts:486` mutates a candidate with `Object.assign(candidate, admission, ...)`. The mutation is same-candidate in the inspected loop; it is not an index mix-up, but immutable transformations would make lineage safer.
- `buildTopicDiverseBatchPlan` and `assignTrendsToPlan` bind by array index. Current call sites preserve order, and the diagnostic two-slot test retained both topics/audiences correctly. Stable IDs are not asserted at this boundary.
- LLM claim narrowing receives plans and trends as parallel arrays; the final trace retained the correct source claim here, but schema-level ID reconciliation is absent.
- `enrichWithEvidence` spreads the strategy candidate and attaches searched source evidence. It preserves the strategy claim/mechanism rather than replacing them, so it did not cause this case. Its matching score is the maximum of claim, mechanism, or discounted territory similarity, which can accept adjacent-domain evidence.
- Candidate identity is strongest in diagnostic trace/inventory paths, not a required end-to-end type invariant.

## G. Multi-Niche Isolation Findings

Niches are **operationally separated during query execution but not semantically isolated end to end**.

- Each niche gets its own expansion plan and query loop in `trendOrchestrationService`.
- Retrieved candidates receive `originNiche`, `profileFingerprint`, `originatingQuery`, intent, and source.
- All niches later enter a common ranked/unified pool; that is intentional.
- Audiences are global strategy audiences, not scoped per pillar/territory. A candidate can therefore inherit relevance from the creator’s global audience even when the source domain does not serve that audience.
- Recent-content memory is user-wide and cross-niche. It supplies diversity penalties rather than topic/audience fields, so it is not the cause here.
- Planner slots preserved array order in the diagnostic test; no `Promise.all` ordering bug was found because results are mapped back by slot index.

Thus, candidate objects are mostly niche-labeled, but the relationship between a candidate’s niche and the global audience model is not isolated or validated.

## H. Search/Enrichment Findings

The exact source is real and intentionally cross-domain: [PubMed](https://pubmed.ncbi.nlm.nih.gov/42038999/), [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC13106199/), [Frontiers](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2026.1675801/full).

The source contamination mechanism is confirmed:

- Query: `Unity game design principles research`.
- Result: research applying game-design principles to mHealth.
- Broad matching terms included `game design`, `user experience`, `design challenges`, `framework`, and research/change vocabulary.
- Query context participated in classifying the result, so the search instruction partially served as evidence that its own result belonged to the niche.
- Directionality was never tested: “mHealth borrows game design” is not equivalent to “this is useful Unity-development content for Indie Game Devs.”

Cache findings:

- Trend cache key: source + freshness + normalized query (`trendFetchCache.ts:39`). It does not include user, audience, niche ID, or profile fingerprint.
- Raw cached results are spread into a fresh object with niche/profile/query provenance in `trendsService.ts:608+` before admission mutation, reducing direct metadata leakage.
- Topic-fingerprint cache includes title/link plus profile fingerprint or origin niche (`topicFingerprintService.ts:62`), which is materially safer.
- Preview pools are scoped by user and a config hash containing sorted niches, sources, and plan version.
- The weakly scoped raw trend cache can reuse the same source across users/niches for an identical query, but classification is rerun. It is a state-hardening concern, not evidence for this incident.

## I. Writer Findings

The writer did not originate the mHealth/M.A.G.I.C./game-design combination; those concepts already coexisted in the selected source and plan. It also did not originate the Unity framing; the candidate was already assigned the Unity pillar and game-developer idea family.

The writer did contribute the explicit audience contamination. `buildAuthorBlock` always prints `CONFIGURED AUDIENCE OPTIONS: Indie Game Devs, ...`, while `buildPlanBlock` printed `broadly relevant readers; do not insert a configured audience label` because `resolvedAudience` was empty. The global and slot-level instructions therefore conflicted in salience. The writer used “Indie Game Developers” twice despite the slot instruction.

The writer is not empowered to reject a plan, return a planner error, or request candidate reselection. Its claim contract says to preserve the selected meaning and not change audience implication or mechanism. It is primarily a realization layer, not a semantic-plan arbiter.

## J. Validation Findings

Current deterministic checks cover:

- post length/depth completeness
- unsupported first-person and authority claims
- opening/first-three-lines rules
- known technical overclaim patterns
- specificity signals
- angle/form requirements
- semantic progression/repetition/stagnation
- generic ending
- hashtag count
- batch/body similarity
- topic fingerprint/history duplication
- LinkedIn formatting and platform limits
- image copy safety when applicable

The technical reviewer scores information density, progression, redundancy, generic-discourse risk, specificity, claim fidelity, technical correctness/factual safety, and audience/objective quality. However, neither deterministic code nor a mandatory reviewer decision validates this graph:

`source domain ↔ selected pillar ↔ topic/claim ↔ mechanism ↔ resolved audience ↔ consequence/ending`.

Generic uses of “coherence,” “claim fidelity,” and “audience objective” do not establish that invariant. The exact bad post received zero reviewer issues and normal acceptance.

## K. Repair/Fallback Findings

For the observed post, fallback did not contribute: one initial draft was accepted as `NORMAL_ACCEPTANCE`, so no repair, regeneration, alternate idea, or emergency fallback executed.

When repair does execute, `buildRepairPrompt` repeats the same author block and same `buildPlanBlock`, tells the model to preserve the claim contract, and asks for minimal edits. It can repair wording, progression, specificity, and detected claims; it cannot repair an invalid idea tuple unless a validator first emits a suitable issue and the repair is allowed to change the plan.

Batch fallback hierarchy is approximately:

1. initial draft
2. up to two targeted repairs per fresh generation
3. additional fresh generations within slot budgets
4. alternate idea recovery when idea-failure rules fire
5. retain best usable candidate (`BEST_USABLE_FALLBACK`)
6. bounded safe writer fallback
7. emergency acceptance where only critical platform/authority/completeness codes remain blocking

The availability guarantee can therefore return a semantically weak candidate if semantic incoherence is not represented as a critical issue code. That is a general architectural risk, although it was not exercised in this trace.

Manual fallback similarly preserves the original selected plan, ranks usable drafts mainly by length and deterministic warning count, and can return a draft with non-blocking quality warnings. It also lacks a semantic-frame gate.

## L. Reproduction Results

A diagnostic-only test was added at `src/services/semanticCoherenceFailure.audit.test.ts`; production code was untouched. Command:

`node --require ts-node/register --test src/services/semanticCoherenceFailure.audit.test.ts`

Result: 3/3 passing, proving current behavior.

| Scenario | Result |
|---|---|
| A — healthcare-native audience plus unrelated game context | The live trace is stronger than a synthetic reproduction: the slot audience resolved to empty, but global Indie Game Dev context remained available and was inserted by the writer. No evidence of fields copied from a separate healthcare candidate. |
| B — two candidate slots | Topics and `resolvedAudience` stayed with their respective indexes in deterministic planning. Adjacent-slot mixing was not reproduced. |
| C — adjacent-domain search source | Reproduced structurally and confirmed by the live trace: a cross-domain mHealth/game-design source survives as a Unity candidate when creator/pillar scores are high. |
| D — deterministic fallback | Code inspection shows the fallback derives topic from the same input and audience from global author context; no separate-candidate merge was found. It still lacks a tuple invariant, so coherence is implied rather than guaranteed. |
| E — intentionally corrupted tuple | Reproduced: `evaluateCandidateCoherence` returned no rejection for the observed-style candidate; deterministic planning produced a valid plan; the writer prompt contained the mHealth claim and Indie Game Dev global audience simultaneously. |

## M. Root Cause Ranking

| Failure class / cause | Ranking | Evidence |
|---|---|---|
| Search/classification contamination | **Confirmed** | Exact query/source and `category_plus_context` trace; Unity pillar assigned to mHealth paper |
| Candidate-generation/semantic-frame failure | **Confirmed** | Pre-writer candidate already had mHealth + Unity pillar + game-dev idea family |
| Reviewer failure | **Confirmed** | Initial draft passed with zero issues and normal acceptance |
| Writer contribution | **Confirmed** | Writer inserted configured audience despite empty resolved audience and explicit no-label instruction |
| Additive scoring masking incompatibility | **Confirmed** | 100 subject relevance and 95 creator fit with audience naturalness 26; no rejection |
| Editorial-layer failure | **Confirmed** | Valid structural plan generated without tuple validation |
| Repair/fallback escape | **Possible generally; ruled out for this post** | No repair/fallback occurred in the trace |
| Candidate-merging/index failure | **Unlikely** | Stable candidate/source trace and passing two-slot diagnostic |
| Multi-niche object cross-contamination | **Unlikely for this post; architectural risk remains** | No evidence of Candidate A/B field merge; global audience is unscoped |
| State/cache contamination | **Unlikely** | No conflicting prior candidate in trace; cache classification is rerun on spread objects |
| Pure writer hallucination as root cause | **Ruled out** | Mixed semantic frame existed before writer |

## N. Architectural Gaps

1. No first-class `SemanticFrame` aggregate with one immutable ID and explicit provenance per component.
2. No relation/invariant distinguishes intentional cross-domain transfer from accidental adjacency.
3. Search classification uses query context as reinforcing evidence for result relevance.
4. Pillar selection can default to the first active pillar after broad category satisfaction.
5. Scalar weighted scores substitute for relational compatibility checks.
6. Audience is global; it is not scoped or resolved per pillar/territory/source domain.
7. Low audience naturalness is a penalty, not a hard relational failure.
8. Editorial planning validates rhetorical form, not semantic-frame integrity.
9. Authority answers “may the author say this?” rather than “does this belong in this frame?”
10. Writer prompts expose global audience options even when the slot intentionally resolves no audience.
11. Reviewer checks are not an enforceable semantic contract and can silently pass.
12. Repair preserves a potentially invalid plan.
13. Emergency/best-usable fallback has no critical semantic-corruption code to respect.
14. Stable candidate IDs and frame hashes are not required at every array/LLM boundary.

## O. Recommended Fix Direction

Do not implement these until the design is approved.

1. Introduce a niche-generic `SemanticFrame` containing `frameId`, `domainId`, pillar/territory IDs, topic/claim, mechanism, audience, consequence, source-domain relationship, authority requirement, and provenance for each field.
2. Require an explicit `relationshipType` for cross-domain content, such as `SAME_DOMAIN`, `DOMAIN_A_BORROWS_FROM_B`, `COMPARISON`, or `TRANSFERABLE_ANALOGY`, plus a one-sentence bridge claim. Cross-domain is allowed only when this is intentional and source-supported.
3. Add a deterministic relational gate before selection and again before persistence. It should reject missing/contradictory relationships, not use niche-specific keywords.
4. Stop allowing originating-query context to prove result-domain membership. Query context may retrieve a result; source evidence must independently establish classification.
5. Remove first-pillar fallback when a source lacks a specific pillar match. Retain such sources as evidence-only or unclassified.
6. Make audience resolution pillar/territory-specific and omit global audience labels from the writer prompt unless the selected frame resolves them.
7. Change scoring so a missing required relation is a gate, not a weight that unrelated high scores can offset.
8. Make editorial planning and claim narrowing accept/return the same `frameId`; reject any response that changes frame components without an explicit reframe operation.
9. Add a deterministic semantic issue code (for example, `SEMANTIC_FRAME_INTEGRITY`) to the critical set. It must trigger idea reselection, not wording repair.
10. Preserve availability by falling back to a prevalidated coherent evergreen frame from the same pillar/domain, rather than returning the best prose for a corrupt frame.
11. Add telemetry with hashes/truncated labels rather than full sensitive content: `generationId`, `slotId`, `candidateId`, `frameId`, domain/pillar/territory IDs, audience ID, source IDs, relationship type, classification evidence, plan/frame hash, validation disposition, repair reason, and final provenance.
12. Add invariant tests for all A–E scenarios and property tests that randomly permute fields across frames; any unintentional permutation must be rejected before writing.

## P. Files That Would Need Modification

| File | Likely change |
|---|---|
| `src/services/generationTypes.ts` | Define required semantic-frame identity, domain/audience/source relationship and provenance types |
| `src/services/semanticIdeaGenerationService.ts` and `src/services/contentIdeaService.ts` | Require coherent frame output and explicit cross-domain relationship |
| `src/services/botStrategyTrendService.ts` | Remove circular category-plus-query proof and first-pillar default; emit evidence provenance |
| `src/services/searchCandidateAdmissionService.ts` | Add relational admission gates and directional source/domain checks |
| `src/services/candidateCoherenceService.ts` | Replace/augment weighted scalar checks with tuple invariants |
| `src/services/trendSelectionService.ts` | Avoid mutation; carry immutable candidate/frame IDs through ranking |
| `src/services/unifiedBatchCandidateService.ts` | Enforce frame integrity before selection/enrichment; constrain evidence attachment |
| `src/services/ghostwriterBatchPlanner.ts` | Bind plans by candidate/frame ID, not only index; preserve frame hash |
| `src/services/claimNarrowingService.ts` and `src/services/contentService.ts` | Validate that LLM claim narrowing does not reframe or detach metadata |
| `src/services/editorialDecisionService.ts` | Refuse or mark plans whose semantic frame is invalid before choosing form |
| `src/services/ghostwriterPrompts.ts` | Include only resolved slot audience; expose cross-domain bridge explicitly; permit structured rejection/reselection |
| `src/services/ghostwriterValidationService.ts` | Add final semantic-frame integrity validation and critical code |
| `src/services/ghostwriterGenerationService.ts` | Route semantic failures to idea replacement; never wording-repair a corrupt frame; coherent evergreen fallback |
| `src/services/userKnowledgeAuthorityService.ts` | Keep authority separate but consume frame IDs and report topic-scope mismatch distinctly |
| `src/services/trendFetchCache.ts` / `topicFingerprintService.ts` | Harden cache scope/versioning and return immutable copies |
| `src/services/batchGenerationTraceService.ts` | Record frame/component provenance and validation transitions |
| `src/services/manualPost/manualPostPlanning.ts` | Apply the shared semantic-frame schema to manual plans |
| `src/services/manualPost/manualPostMultiStage.ts` | Run the shared frame gate and use plan replacement, not wording repair, for semantic failure |
| Batch/manual tests plus `semanticCoherenceFailure.audit.test.ts` | Convert diagnostic reproductions into prevention tests after design approval |

### Incident evidence summary

- Post ID: `cmtcsey310028opo3gq6fv0hh`
- Batch/job ID: `cmtcscmro0023opo3cpyb667v`
- Candidate trace ID: `029a68a0dad12574`
- Final provenance: `NORMAL_ACCEPTANCE`
- Initial drafts: 1
- Reviewer: passed, no issue codes
- Repair/fallback: none
