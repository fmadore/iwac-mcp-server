// User-invocable MCP prompts.
//
// Claude Desktop layers the rich `iwac-mcp` skill on top of this server; a
// skill-less client (ChatGPT via the remote connector, or any host without the
// skill installed) has only the handshake `instructions` string, which is a
// floor, not a workflow. Prompts are the one channel that reaches those clients
// with a full method — the host surfaces them for the USER to pick, so they
// cost nothing until invoked, unlike instructions that ride every request.
//
// These deliberately mirror .agents/skills/iwac-mcp/SKILL.md (depth choice,
// five phases, token budget, confidence grading, citation rule). When one
// changes, change the other — the same rule the INSTRUCTIONS block carries.
import { z } from "zod";
import type { Server } from "./tools/_shared.js";

const CITATION_RULE =
  "Cite every IWAC item with the full `url` from its result row, rendered as a markdown link — " +
  "never a short form like \"art. #28576\".";

const LANGUAGE_RULE =
  "Write the report in the language of the question, but formulate search keywords in FRENCH for press, " +
  "publications, documents and index lookups (laïcité, confrérie, pèlerinage, enseignement islamique), " +
  "using French transliterations of Islamic terms (Tabaski, charia, Maouloud). Academic references are " +
  "multilingual — search them in French AND English.";

const COVERAGE_RULE =
  "Disclose coverage limits in the write-up: Niger is thin (one newspaper, 2018 on), Nigeria has no press " +
  "articles at all (audiovisual and photographs only), the press is ~96% francophone, AI sentiment is " +
  "model-derived rather than editorial ground truth, and this public dataset carries OCR full text only for " +
  "the items whose content is public (~61% of articles) — check `fulltext_coverage` in get_collection_stats " +
  "and present keyword counts as a floor, not a census.";

const BRIEF_STEPS =
  "1. SCOPE in one parallel batch, calling only what the question needs (get_collection_stats, " +
  "get_country_comparison, get_temporal_distribution, list_subjects).\n" +
  "2. SEARCH with one primary query per filter combination — `limit=10` and `with_description=true` so each " +
  "hit carries its AI abstract. Remember the search_* `keyword` filter is ONE substring: search one term per " +
  "call.\n" +
  "3. READ 2-3 of the most relevant items in full (get_article / get_document / get_publication_fulltext), " +
  "triaged on `description_ai`. Never skip this step — a metadata-only answer is not research.\n" +
  "4. SYNTHESISE concisely but substantively, opening with a one-line evidence ledger: how many items were " +
  "read in full, triaged on AI abstracts, and surveyed by count only.\n" +
  "Aim for roughly 25k tokens of tool output.";

const EXTENDED_STEPS =
  "1. SCOPE — get_collection_stats, get_country_comparison, get_newspaper_stats, list_subjects, " +
  "list_periodicals, and get_temporal_distribution to see WHEN coverage exists before searching.\n" +
  "2. SEARCH systematically — multiple keyword variants and transliterations, each as its own call; prefer " +
  "the curated `subject` filter over keywords where a tag exists; cover articles, publications, documents, " +
  "references and the authority index.\n" +
  "3. READ 6-8 key items in full, triaged on `description_ai`. For long items pass a `keyword` to get " +
  "~2000-char excerpts instead of the whole capped OCR.\n" +
  "4. TRIANGULATE — compare press against Islamic publications and scholarship, run " +
  "get_sentiment_distribution and get_temporal_distribution over the topic, and check the index entries for " +
  "the people and places involved.\n" +
  "5. SYNTHESISE with confidence grading: Strong (direct attestation in multiple primary sources), Moderate " +
  "(clear but indirect evidence), Weak (inferred, or an argument from silence — note that absence may " +
  "reflect a collection gap, not a historical one).\n" +
  "Expect 50-120k tokens of tool output; past that, returns diminish — stop searching and synthesise.";

export function registerPrompts(server: Server): void {
  server.registerPrompt(
    "iwac_research",
    {
      title: "IWAC research workflow",
      description:
        "Run a structured, source-cited investigation of the IWAC archive at a chosen depth (brief or " +
        "extended), following the five-phase method: scope, search, read, triangulate, synthesise.",
      argsSchema: {
        question: z.string().describe("The research question, in any language"),
        depth: z
          .string()
          .optional()
          .describe("brief (default: counts, key titles, 2-3 close readings) | extended (full five-phase analysis)"),
      },
    },
    ({ question, depth }) => {
      const extended = (depth ?? "").trim().toLowerCase().startsWith("e");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Research this question using the IWAC MCP tools: ${question}\n\n` +
                `Depth: ${extended ? "EXTENDED" : "BRIEF"}.\n\n` +
                `${extended ? EXTENDED_STEPS : BRIEF_STEPS}\n\n` +
                `${LANGUAGE_RULE}\n\n${CITATION_RULE}\n\n${COVERAGE_RULE}\n\n` +
                "Counting is not fetching: use `total_matches` and the distribution tools to answer " +
                "how much / when / what tone, and reserve full-text reads for the triaged finalists. " +
                "Finish with 3-4 follow-up questions the archive could actually answer." +
                (extended ? "" : " Mention that an extended analysis is available if they want more depth."),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "iwac_overview",
    {
      title: "What is in the IWAC collection?",
      description:
        "A plain-language tour of what the Islam West Africa Collection holds and the kinds of questions it " +
        "can answer — no research run, no tool enumeration.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Give me a plain-language overview of the Islam West Africa Collection: what kinds of material " +
              "it holds, which countries and years it covers, and the kinds of research questions it can " +
              "actually answer. Call get_collection_stats, get_country_comparison and list_subjects to ground " +
              "the answer in the live figures, and include `fulltext_coverage` so I know how much of it is " +
              "searchable as full text. Do not enumerate the tools, and do not start a research project — " +
              "end by offering two or three concrete example questions I could ask.",
          },
        },
      ],
    }),
  );
}
