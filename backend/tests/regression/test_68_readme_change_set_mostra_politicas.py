"""O README diz que o change set não mostra o texto das políticas, e ele mostra.

Erro observado (QA do #68, depois da decisão B): em "Confira as mudanças de IAM", o
`backend/README.md` diz "O change set não mostra o texto das políticas: leia-o no diff do
`infra/template.yaml` no PR ou no template processado do change set". O
`describe-change-set` tem a opção `--include-property-values` ("If true, the returned
changes include detailed changes in the property values", referência da AWS CLI), que
devolve, em cada `Details[].Target`, o `Path`, o `BeforeValue` e o `AfterValue` da
propriedade (no papel de uma função, os trechos de `Policies` que mudaram), e o
`BeforeContext`/`AfterContext` do recurso. No console, a coluna "Property-level changes"
mostra o mesmo, com o antes e o depois lado a lado ("View change set details",
using-cfn-updating-stacks-changesets-view.html, no guia do CloudFormation). O texto foi
conferido no modelo do botocore e na documentação pública em 2026-11-18. Os valores
grandes podem vir truncados, e por isso o template processado continua sendo a leitura
completa. Ainda assim, a frase manda quem aprova (a única proteção do risco aceito,
segundo o próprio README) para longe da única visão que mostra o antes e o depois da
política no change set.

Esperado: a seção da esteira não diz que o change set não mostra o texto (ou o conteúdo)
das políticas, a não ser que o mesmo bloco, ou o seguinte (o bloco de código, por
exemplo), cite `--include-property-values` ou a visão "Property-level changes" do
console.
Issue: #68
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"

CHANGE_SET = re.compile(r"\bchange\s+sets?\b", re.IGNORECASE)
DOES_NOT_SHOW = re.compile(
    r"\bnão\s+(?:mostra|mostram|exibe|exibem|traz|trazem|lista|listam|inclui|incluem|"
    r"tem|têm|dá|dão|revela|revelam)\b",
    re.IGNORECASE,
)
POLICY_TEXT = re.compile(
    r"\b(?:texto|conteúdo|documento|corpo)\s+d[ao]s?\s+polític|\bPolicyDocument\b",
    re.IGNORECASE,
)
QUALIFIED = re.compile(r"--include-property-values|property-level", re.IGNORECASE)


def _cd_section() -> str:
    text = README.read_text(encoding="utf-8")
    start = re.search(r"^## .*esteira.*$", text, flags=re.MULTILINE | re.IGNORECASE)
    assert start, 'o README deveria ter a seção "## Deploy pela esteira (CodePipeline)"'
    end = re.search(r"^## ", text[start.end() :], flags=re.MULTILINE)
    return text[start.start() : start.end() + end.start()] if end else text[start.start() :]


def _blocks(markdown: str) -> list[str]:
    """Paragraphs and fenced code blocks, split on blank lines (the code is kept: a
    command right after the paragraph counts as its qualification)."""
    return [block.strip() for block in re.split(r"\n\s*\n", markdown) if block.strip()]


def _sentences(text: str) -> list[str]:
    flat = " ".join(text.split())
    return [s for s in re.split(r"(?<=[.!?:])\s+(?=[^a-zà-ÿ])", flat) if s]


def _claims_hidden_policies(sentence: str) -> bool:
    return bool(
        CHANGE_SET.search(sentence)
        and DOES_NOT_SHOW.search(sentence)
        and POLICY_TEXT.search(sentence)
    )


def test_readme_does_not_say_the_change_set_hides_the_policy_text() -> None:
    # The detector itself: the wording that failed, a qualified one and a neutral one.
    assert _claims_hidden_policies("O change set não mostra o texto das políticas.")
    assert not _claims_hidden_policies(
        "O change set fica na stack até a próxima execução substituí-lo."
    )
    assert not _claims_hidden_policies("Os detalhes dizem que propriedade mudou: `Policies`.")

    blocks = _blocks(_cd_section())
    unqualified = [
        sentence
        for index, block in enumerate(blocks)
        for sentence in _sentences(block)
        if _claims_hidden_policies(sentence)
        and not QUALIFIED.search(" ".join(blocks[index : index + 2]))
    ]

    assert not unqualified, (
        "O backend/README.md diz que o change set não mostra o texto das políticas, mas o "
        "`aws cloudformation describe-change-set --include-property-values` devolve o antes "
        "e o depois (BeforeValue/AfterValue) de cada propriedade que muda, inclusive os "
        "`Policies` do papel de uma função, e o console mostra o mesmo em 'Property-level "
        "changes'. Cite essa opção (ou a visão do console) na orientação de quem aprova, "
        "dizendo que valores grandes podem vir truncados e que o template processado é a "
        f"leitura completa: {unqualified}"
    )
