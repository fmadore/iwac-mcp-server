"""Reference vectors for the EmbeddingGemma 2 query encoder.

Writes the fixture the parity test checks the Node encoder against
(test/embeddinggemma2-reference.json), and src/embeddingProbe.ts, the
probe vector and corpus anchors the embedding contract verifies. Run it with the Python
environment of the IWAC-Hugging-Face pipeline, whose ``_gemma_encoder`` produced
the corpus vectors, so both sides of the comparison are the published reference:

    python -I scripts/make-embedding-reference.py \
        --upstream ../../IWAC-Hugging-Face/post-processing \
        --dataset-dir <dir with articles.parquet, documents.parquet, ...> \
        --dataset-revision <the commit those files came from>

The parquet files must come from the dataset revision named, because the anchor
cosines are measured against them. Only the fp32 ONNX graph is used: that is the
graph the corpus was embedded with.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

# The first query is the contract's probe: the server encodes it once to check
# its own encoder, and measures it against the anchors to check the corpus.
QUERIES = [
    "pèlerinage à La Mecque",
    "fête de la Tabaski à Ouagadougou",
    "Eid al-Adha celebrations in Lomé",
    "hadj, hajj ou haj : l'organisation du pèlerinage",
    "Cheick ou Cheikh Doukouré",
    "AEEMB",
    "conflits entre wahhabites et soufis au Burkina Faso",
    "الإسلام في غرب أفريقيا",
    "Ramadan 1442 – croissant lunaire et Aïd el-Fitr",
    "école franco-arabe, médersa et enseignement coranique",
    "women's Islamic associations in Côte d'Ivoire",
    "Union islamique du Burkina (UIB) et Communauté musulmane (CMBF)",
    "Ọ̀yọ́ : les musulmans yorùbá et la « laïcité » au Bénin",
    "Comment la presse ivoirienne a-t-elle couvert les relations entre le Conseil national "
    "islamique, les jeunes musulmans et l'État pendant les crises politiques des années 1990 "
    "et 2000, en particulier autour des élections et de la question de l'ivoirité ?",
]

# Vector column per subset, as published at the dataset revision named.
FIELDS = {
    "articles": "embedding_OCR",
    "documents": "embedding_OCR",
    "publications": "embedding_tableOfContents",
    "references": "embedding_abstract",
    "images": "embedding_image",
}
ANCHORS_PER_SUBSET = 3


def b64(vector: np.ndarray) -> str:
    return base64.b64encode(np.asarray(vector, dtype="<f4").tobytes()).decode("ascii")


def anchors(dataset_dir: Path, probe: np.ndarray) -> list[dict]:
    """The lowest o:ids carrying a vector in each subset, with their cosine to
    the probe. Low ids are the oldest records, the least likely to be edited."""
    found = []
    for subset, column in FIELDS.items():
        table = pq.read_table(dataset_dir / f"{subset}.parquet", columns=["o:id", column]).to_pylist()
        rows = sorted((r for r in table if r[column]), key=lambda r: int(r["o:id"]))[:ANCHORS_PER_SUBSET]
        if len(rows) < ANCHORS_PER_SUBSET:
            raise SystemExit(f"{subset} has fewer than {ANCHORS_PER_SUBSET} vectors")
        for row in rows:
            vector = np.asarray(row[column], dtype=np.float32)
            cosine = float(vector @ probe / (np.linalg.norm(vector) * np.linalg.norm(probe)))
            found.append({"subset": subset, "id": str(row["o:id"]), "cosine": round(cosine, 6)})
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upstream", type=Path, required=True, help="IWAC-Hugging-Face/post-processing")
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--dataset-revision", required=True)
    root = Path(__file__).parent.parent
    parser.add_argument("--output", type=Path, default=root / "test" / "embeddinggemma2-reference.json")
    parser.add_argument("--contract-output", type=Path, default=root / "src" / "embeddingProbe.ts")
    args = parser.parse_args()

    sys.path.insert(0, str(args.upstream.resolve()))
    import _gemma_encoder as gemma  # noqa: E402  (path set above)

    encoder = gemma.GemmaEncoder()
    texts = [gemma.query_text(q) for q in QUERIES]
    vectors = encoder.encode(texts)
    encodings = encoder.tokenizer.encode_batch(texts)

    reference = {
        "about": "Python reference query vectors; regenerate with scripts/make-embedding-reference.py",
        "model": f"{gemma.MODEL_ID}@{gemma.MODEL_REVISION}",
        "onnx_export": f"{gemma.ONNX_ID}@{gemma.ONNX_REVISION}",
        "precision": "fp32",
        "query_prefix": gemma.QUERY_PREFIX,
        "dimension": gemma.DIMENSION,
        "runtime": gemma.runtime_versions(),
        "queries": [
            {"query": q, "token_ids": e.ids, "vector": b64(v)}
            for q, e, v in zip(QUERIES, encodings, vectors)
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(reference, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    probe = {
        "query": QUERIES[0],
        "vector": b64(vectors[0]),
        "anchors_dataset_revision": args.dataset_revision,
        "anchors": anchors(args.dataset_dir, vectors[0]),
    }
    args.contract_output.write_text(
        "// Generated by scripts/make-embedding-reference.py from the Python reference\n"
        "// encoder and the dataset revision named below. Do not edit by hand.\n"
        f"export const CORPUS_PROBE = {json.dumps(probe, ensure_ascii=False, indent=2)} as const;\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
