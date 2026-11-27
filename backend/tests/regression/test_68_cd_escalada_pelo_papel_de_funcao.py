"""O repositório promete que um deploy do app não alcança a esteira, e ele alcança.

Erro observado (QA do #68): o `CloudFormationExecutionRole` de `infra/cd-pipeline.yaml`
mexe em IAM só em `role/<AppStackName>-*`, e os papéis da esteira ficam em `role/cd/`.
Mesmo assim, ele grava qualquer política inline nos papéis das funções
(`iam:CreateRole` e `iam:PutRolePolicy`, sem permissions boundary) e entrega esses
papéis à Lambda (`iam:PassRole`). Um commit do `main` que dê à `SeedFunction` a política
`iam:*` em `*` passa pela esteira assim: o papel de execução grava a política no papel
da função, o CloudFormation invoca a função no `Custom::InitialData` do mesmo deploy, e
o código dela altera os papéis da esteira (o próprio `cd-<AppStackName>-cfn-exec`
incluído) ou apaga os buckets dela. Uma função invocada depois, pela API, faz o mesmo.
Ainda assim, o `backend/README.md` afirma que "um deploy do app não consegue alterar os
papéis da esteira, nem o próprio papel de execução", e o docstring de
`test_cd_roles_stay_outside_the_execution_role_scope` promete o mesmo. As duas frases
só valem para o padrão do ARN.

Reescrito em 2026-11-18 pela decisão B do responsável. A primeira versão deste teste
exigia um permissions boundary nos papéis das funções. O responsável decidiu não criar
o boundary naquele momento: o risco ficou aceito, porque era o mesmo do `sam deploy`
manual com credencial de administrador, e a proteção era a revisão do PR e do change
set. O boundary foi para o card #179, e a versão anterior deste arquivo (commit 3821d03)
serviu de ponto de partida para o teste de lá.

Contexto atualizado no #179 (2026-11-26): o caminho indireto foi fechado. A stack de CD
cria o `FunctionBoundaryPolicy`, o limite de permissões de todos os papéis das funções,
e o papel de execução só cria um papel de função, grava as políticas dele ou muda a
política de confiança quando o limite do papel é essa política (condição
`iam:PermissionsBoundary`); nunca o tira. O que confere o limite e as condições é o
`tests/test_cd_function_boundary.py`. Este teste continua valendo, sem mudar as
asserções, para a documentação: o alcance direto é o padrão do ARN, o indireto é o
limite, e o README precisa continuar dizendo os dois, sem prometer isolamento sem a
ressalva. A seção do README que descrevia o risco aceito passou a se chamar "Limite de
permissões dos papéis das funções" e conta o caminho indireto e como o limite o fecha.

Esperado:
- nenhuma frase do README e nenhuma do docstring promete que um deploy do app (ou o
  papel de execução) não alcança os papéis ou os buckets da esteira sem a ressalva logo
  ali, no mesmo parágrafo ou no seguinte: o card #179 (o limite) ou o caminho indireto;
- a seção da esteira no README descreve o caminho indireto: o papel de execução grava
  políticas nos papéis das funções (`role/<AppStackName>-*`), e, sem o limite, uma
  função invocada no mesmo deploy (o `Custom::InitialData`) ou depois poderia usá-las
  contra a esteira;
- a mesma seção orienta quem aprova o change set a conferir as mudanças de IAM (papéis
  e políticas das funções) e cita o card #179. Com o limite, essa revisão continua
  sendo a proteção dos dados do app, que as funções alcançam dentro dele.

As asserções procuram marcadores, não a redação exata: a promessa é uma frase que fala
dos papéis ou dos buckets da esteira (ou do próprio papel de execução) e diz que não dá
para alcançá-los; a ressalva é o `#179` ou "indiretamente".
Issue: #68 (boundary: #179)
"""

import re
from pathlib import Path

import test_cd_pipeline_template as cd_tests

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
CARD = "#179"

# --- the promise, in pt-BR (README) and in English (docstrings)
CD_TARGET_PT = re.compile(
    r"\bpap(?:el|éis)\s+d[aeo]\s+(?:esteira|cd)\b"
    r"|\bbuckets?\s+d[aeo]\s+(?:esteira|cd)\b"
    r"|\bpróprio\s+papel\s+de\s+execução\b",
    re.IGNORECASE,
)
CANNOT_PT = re.compile(
    r"\bnão\s+(?:consegue|pode|alcança|altera|mexe|chega|tem\s+como)\b"
    r"|\bnunca\s+(?:consegue|pode|alcança|altera|mexe|chega)\b"
    r"|\bfora\s+do\s+alcance\b",
    re.IGNORECASE,
)
CAVEAT_PT = re.compile(r"#179\b|\bindiretamente\b", re.IGNORECASE)

CD_TARGET_EN = re.compile(
    r"\b(?:cd|pipeline)\s+(?:roles?|buckets?)\b"
    r"|\b(?:roles?|buckets?)\s+of\s+the\s+(?:cd|pipeline)\b"
    r"|\bits\s+own\s+role\b",
    re.IGNORECASE,
)
CANNOT_EN = re.compile(
    r"\b(?:must|can|could|will|may)\s+never\b"
    r"|\bnever\s+(?:changes?|reach(?:es)?|touch(?:es)?|alters?|modif(?:y|ies))\b"
    r"|\bcan(?:not|'t|\s+not)\b"
    r"|\bout\s+of\s+(?:its\s+)?reach\b",
    re.IGNORECASE,
)
CAVEAT_EN = re.compile(r"#179\b|\bindirect(?:ly)?\b", re.IGNORECASE)

# --- what the README must say about the risk and the review
FUNCTION_ROLES = re.compile(
    r"role/<[^>`\s]+>-\*|\bpap(?:el|éis)\s+d(?:e\s+uma|a|as)\s+funç(?:ão|ões)\b", re.IGNORECASE
)
POLICIES = re.compile(r"polític|PutRolePolicy|\bPolicies\b", re.IGNORECASE)
RISK = re.compile(r"\brisco\b|\bpoderia\b|\bpoderiam\b|\bindiretamente\b", re.IGNORECASE)
REVIEW = re.compile(r"\baprov|\bconfer|\bconfir|\brevis", re.IGNORECASE)
IAM_ROLES = re.compile(r"\bpap(?:el|éis)\b|AWS::IAM::Role", re.IGNORECASE)


def _sentences(text: str) -> list[str]:
    flat = " ".join(text.split())
    return [s for s in re.split(r"(?<=[.!?])\s+(?=[^a-zà-ÿ])", flat) if s]


def _promises(sentence: str, target: re.Pattern[str], cannot: re.Pattern[str]) -> bool:
    return bool(target.search(sentence) and cannot.search(sentence))


def _blocks(markdown: str) -> list[str]:
    """Paragraphs (a list without blank lines between its items is one block),
    with the fenced code removed."""
    prose = re.sub(r"```.*?```", "", markdown, flags=re.DOTALL)
    return [block.strip() for block in re.split(r"\n\s*\n", prose) if block.strip()]


def _cd_section() -> str:
    text = README.read_text(encoding="utf-8")
    start = re.search(r"^## .*esteira.*$", text, flags=re.MULTILINE | re.IGNORECASE)
    assert start, 'o README deveria ter a seção "## Deploy pela esteira (CodePipeline)"'
    end = re.search(r"^## ", text[start.end() :], flags=re.MULTILINE)
    return text[start.start() : start.end() + end.start()] if end else text[start.start() :]


def test_readme_does_not_promise_that_a_deploy_cannot_reach_the_cd() -> None:
    # The detector itself: the wording of the round that failed, and two neutral ones.
    promise = (
        "Um ARN `role/cd/...` nunca casa com `role/<stack>-*`, então um deploy do app não "
        "consegue alterar os papéis da esteira, nem o próprio papel de execução."
    )
    assert _promises(promise, CD_TARGET_PT, CANNOT_PT)
    assert not _promises("Ele não pode começar com `tomiyama-dev-`.", CD_TARGET_PT, CANNOT_PT)
    assert not _promises("Os papéis da esteira ficam no caminho `/cd/`.", CD_TARGET_PT, CANNOT_PT)

    blocks = _blocks(README.read_text(encoding="utf-8"))
    unqualified = [
        sentence
        for index, block in enumerate(blocks)
        for sentence in _sentences(block)
        if _promises(sentence, CD_TARGET_PT, CANNOT_PT)
        and not CAVEAT_PT.search(" ".join(blocks[index : index + 2]))
    ]

    assert not unqualified, (
        "O backend/README.md promete que um deploy do app não alcança a esteira, mas o papel "
        "de execução grava qualquer política nos papéis das funções, e uma função alcança os "
        "papéis e os buckets da esteira (risco aceito na decisão B; boundary no card #179). "
        "Ponha a ressalva no mesmo parágrafo ou no seguinte (o card #179, ou o caminho "
        f"'indiretamente'): {unqualified}"
    )


def test_execution_role_scope_test_does_not_promise_isolation() -> None:
    doc = cd_tests.test_cd_roles_stay_outside_the_execution_role_scope.__doc__ or ""
    assert _promises(
        "An app deploy must never change the roles of the CD.", CD_TARGET_EN, CANNOT_EN
    )
    promises = [s for s in _sentences(doc) if _promises(s, CD_TARGET_EN, CANNOT_EN)]

    assert not promises or CAVEAT_EN.search(doc), (
        "O docstring de test_cd_roles_stay_outside_the_execution_role_scope promete que um "
        "deploy do app não alcança os papéis da esteira, e o teste só confere o padrão do "
        "ARN. Diga que é só o alcance direto e cite o caminho indireto ('indirectly') ou o "
        f"card #179: {promises}"
    )


def test_readme_describes_the_function_role_risk() -> None:
    described = [
        block
        for block in _blocks(_cd_section())
        if FUNCTION_ROLES.search(block)
        and POLICIES.search(block)
        and "InitialData" in block
        and re.search(r"\besteira\b", block, flags=re.IGNORECASE)
        and RISK.search(block)
    ]

    assert described, (
        "A seção da esteira no backend/README.md não descreve o risco aceito na decisão B. "
        "Um parágrafo (ou uma lista) deveria dizer que o papel de execução grava políticas "
        "nos papéis das funções (role/<AppStackName>-*) e que uma função invocada no mesmo "
        "deploy (o Custom::InitialData) ou depois poderia usá-las contra a esteira (seus "
        "papéis e buckets)."
    )


def test_readme_tells_the_change_set_approver_to_check_iam_changes() -> None:
    guided = [
        block
        for block in _blocks(_cd_section())
        if CARD in block
        and re.search(r"\bchange sets?\b", block, flags=re.IGNORECASE)
        and REVIEW.search(block)
        and re.search(r"\bIAM\b", block)
        and IAM_ROLES.search(block)
        and POLICIES.search(block)
    ]

    assert guided, (
        "A seção da esteira no backend/README.md não orienta quem aprova o change set a "
        "conferir as mudanças de IAM (papéis e políticas das funções, como os Policies do "
        "infra/template.yaml), a única proteção contra o risco aceito na decisão B, nem cita "
        f"o card {CARD}, onde ficou o permissions boundary."
    )
