"""Um comentário do template de CD ainda promete que um deploy do app só lê os buckets dela.

Erro observado (QA do #68, depois da decisão B): no `infra/cd-pipeline.yaml`, o comentário
do `Sid: NeverManageTheCdBuckets` diz "Belt and braces: even if this stack's name started
with "<AppStackName>-", an app deploy could only read packages here." A negação vale só
para o papel de execução. O próprio `backend/README.md` ("Risco aceito: os papéis das
funções") e o topo do template dizem que uma função invocada no mesmo deploy (a
`SeedFunction`, pelo `Custom::InitialData`) pode apagar os buckets da esteira, se um commit
der permissões amplas ao papel dela. Com a stack de CD num nome "<AppStackName>-...", nem
`iam:*` é preciso: basta uma política inline com `s3:DeleteBucket` em
`arn:aws:s3:::<AppStackName>-*`, que o papel de execução grava sem boundary (card #179).
O docstring de `test_execution_role_cannot_manage_the_cd_buckets` recebeu a ressalva
("Direct reach only"), mas o comentário do template, não.

Esperado: nenhum comentário do template diz o que um deploy do app pode ou não pode fazer
(só ler, nunca alterar) sem a ressalva no mesmo bloco de comentário ou no seguinte: o
caminho indireto ("indirect", "indirectly") ou o card #179. Também vale trocar o sujeito da
frase para o papel de execução ("the execution role could only read packages here").
Issue: #68 (boundary: #179)
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CD_TEMPLATE = ROOT / "infra" / "cd-pipeline.yaml"

APP_DEPLOY = re.compile(
    r"\bapp(?:\s+stack)?\s+deploy(?:s|ment)?\b|\bdeploy(?:s|ment)?\s+of\s+the\s+app\b",
    re.IGNORECASE,
)
RESTRICTED = re.compile(
    r"\b(?:can|could|may|will)\s+only\b"
    r"|\bonly\s+(?:reads?|reach(?:es)?|touch(?:es)?|gets?)\b"
    r"|\b(?:can|could|may|will|must)\s+never\b"
    r"|\bnever\s+(?:changes?|reach(?:es)?|touch(?:es)?|alters?|modif(?:y|ies)|deletes?)\b"
    r"|\bcan(?:not|'t|\s+not)\b",
    re.IGNORECASE,
)
CAVEAT = re.compile(r"#179\b|\bindirect(?:ly)?\b", re.IGNORECASE)


def _comment_blocks(text: str) -> list[tuple[int, str]]:
    """Runs of consecutive comment lines (full-line or trailing), joined, with the
    line where each starts."""
    blocks: list[tuple[int, str]] = []
    current: list[str] = []
    start = 0
    for number, line in enumerate(text.splitlines(), start=1):
        match = re.match(r"\s*#\s?(.*)$", line)
        if match:
            if not current:
                start = number
            current.append(match.group(1))
        elif current:
            blocks.append((start, " ".join(current)))
            current = []
    if current:
        blocks.append((start, " ".join(current)))
    return blocks


def _sentences(text: str) -> list[str]:
    flat = " ".join(text.split())
    return [s for s in re.split(r"(?<=[.!?])\s+(?=[^a-z])", flat) if s]


def _promises(sentence: str) -> bool:
    return bool(APP_DEPLOY.search(sentence) and RESTRICTED.search(sentence))


def test_cd_template_comments_do_not_promise_what_an_app_deploy_cannot_do() -> None:
    # The detector itself: the wording that failed, a qualified one and neutral ones.
    assert _promises(
        'Belt and braces: even if this stack\'s name started with "<AppStackName>-", '
        "an app deploy could only read packages here."
    )
    assert not _promises(
        'Even if this stack\'s name started with "<AppStackName>-", the execution role '
        "could only read packages here."
    )
    assert not _promises("Only the seed function.")
    assert not _promises("Lambda reads the code with the caller's credentials.")

    blocks = _comment_blocks(CD_TEMPLATE.read_text(encoding="utf-8"))
    unqualified = [
        f"linha {start}: {sentence}"
        for index, (start, text) in enumerate(blocks)
        for sentence in _sentences(text)
        if _promises(sentence)
        and not CAVEAT.search(" ".join(block for _, block in blocks[index : index + 2]))
    ]

    assert not unqualified, (
        "Um comentário do infra/cd-pipeline.yaml promete o que um deploy do app não consegue "
        "fazer com a esteira, mas uma função invocada no mesmo deploy (a SeedFunction, pelo "
        "Custom::InitialData) pode apagar os buckets e alterar os papéis dela pelo papel da "
        "própria função (risco aceito na decisão B; boundary no card #179). Diga que a "
        "negação vale para o papel de execução, ou ponha a ressalva no mesmo bloco de "
        f"comentário ou no seguinte ('indirectly' ou o card #179): {unqualified}"
    )
