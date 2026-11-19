use crate::ai;
use crate::model::{Evidence, Line};

/// Acha a menor sequência contígua de linhas cujo texto contém a citação.
/// Devolve os índices das linhas — é isso que permite destacar só as linhas
/// certas no PDF, inclusive em duas colunas. Casamento exato no texto concatenado.
fn exact_span(quote: &str, lines: &[Line]) -> Option<(usize, usize)> {
    let alvo = ai::normalize(quote);
    if alvo.is_empty() {
        return None;
    }
    let mut joined = String::new();
    let mut offsets = Vec::with_capacity(lines.len());
    for line in lines {
        let normalized = ai::normalize(&line.text);
        let start = joined.len();
        joined.push_str(&normalized);
        offsets.push((start, joined.len()));
        // Palavra hifenizada que continua na linha seguinte ("cost-" / "effective")
        // gruda sem espaço, como o `normalize` faz com o hífen no meio do texto.
        if !normalized.is_empty() && !ai::ends_with_hyphen(&line.text) {
            joined.push(' ');
        }
    }
    let inicio = joined.find(&alvo)?;
    let fim = inicio + alvo.len();

    // Primeira linha que termina depois do início e última que começa antes do fim.
    let mut first = None;
    let mut last = None;
    for (index, (start, end)) in offsets.iter().enumerate() {
        if start == end {
            continue; // linha vazia não pertence ao trecho
        }
        if *end > inicio && first.is_none() {
            first = Some(index);
        }
        if *start < fim {
            last = Some(index);
        }
    }
    Some((first?, last?))
}

/// Palavras da citação para o alinhamento tolerante: normalizadas e sem a
/// pontuação das pontas ("mestrado," casa com "mestrado").
fn tokens(text: &str) -> Vec<String> {
    ai::normalize(text)
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Alinha `alvo` com `win` pela maior subsequência comum. Devolve quantas
/// palavras casaram e a primeira e a última posição casadas em `win`.
fn lcs_align(alvo: &[String], win: &[&str]) -> Option<(usize, usize, usize)> {
    let (n, m) = (alvo.len(), win.len());
    let w = m + 1;
    let mut dp = vec![0u16; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * w + j] = if alvo[i] == win[j] {
                dp[(i + 1) * w + j + 1] + 1
            } else {
                dp[(i + 1) * w + j].max(dp[i * w + j + 1])
            };
        }
    }
    let matched = dp[0] as usize;
    if matched == 0 {
        return None;
    }
    let (mut i, mut j) = (0, 0);
    let mut first = None;
    let mut last = 0;
    while i < n && j < m {
        if alvo[i] == win[j] {
            first.get_or_insert(j);
            last = j;
            i += 1;
            j += 1;
        } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    Some((matched, first?, last))
}

/// Alinhamento tolerante: casa a citação palavra por palavra, ignorando
/// diferenças de flexão e pontuação que a IA costuma introduzir. Exige que 70%
/// das palavras apareçam na ordem, senão devolve `None` — citação inventada não
/// vira destaque. Procura em qualquer ponto da página, não só no começo.
fn fuzzy_span(quote: &str, lines: &[Line]) -> Option<(usize, usize)> {
    let mut alvo = tokens(quote);
    if alvo.len() < 5 {
        return None;
    }
    alvo.truncate(80);
    let mut page: Vec<(String, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        for token in tokens(&line.text) {
            page.push((token, index));
        }
    }
    if page.is_empty() {
        return None;
    }

    // A IA pode ter errado as primeiras palavras: aceita entrar por qualquer uma das quatro primeiras.
    let anchors: Vec<&String> = alvo.iter().take(4).collect();
    let window_len = alvo.len() * 2 + 6;
    // (acertos, extensão em palavras, primeira linha, última linha)
    let mut best: Option<(usize, usize, usize, usize)> = None;
    for start in 0..page.len() {
        if !anchors.iter().any(|a| **a == page[start].0) {
            continue;
        }
        let end = (start + window_len).min(page.len());
        let win: Vec<&str> = page[start..end].iter().map(|(t, _)| t.as_str()).collect();
        let Some((matched, first, last)) = lcs_align(&alvo, &win) else { continue };
        let (first, last) = (start + first, start + last);
        let spread = page[last].1 - page[first].1;
        // 70% das palavras da citação, no mínimo, pelo menos cinco acertos, e
        // tudo dentro de poucas linhas: palavra comum espalhada pela página não
        // pode virar uma citação de dez linhas.
        if matched >= 5
            && matched * 10 >= alvo.len() * 7
            && spread <= alvo.len() / 2 + 2
            && last - first <= alvo.len() * 2
        {
            let candidate = (matched, last - first, page[first].1, page[last].1);
            let better = match best {
                None => true,
                // Mais acertos vence; em empate, o trecho mais compacto.
                Some(b) => candidate.0 > b.0 || (candidate.0 == b.0 && candidate.1 < b.1),
            };
            if better {
                best = Some(candidate);
            }
        }
    }
    let (_, _, first, last) = best?;
    Some((first, last))
}

/// Junta o texto das linhas para exibir o trecho, refazendo palavras partidas
/// por hífen no fim da linha.
fn join_lines(window: &[Line]) -> String {
    let mut out = String::new();
    for line in window {
        let text = line.text.trim();
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            // Hífen macio sempre se desfaz; hífen comum só quando a palavra continua em minúscula.
            let broken_word = out.ends_with('\u{00ad}')
                || (out.ends_with('-')
                    && out.chars().rev().nth(1).is_some_and(char::is_alphabetic)
                    && text.chars().next().is_some_and(char::is_lowercase));
            if broken_word {
                out.pop();
            }
            let glue = broken_word;
            if !glue {
                out.push(' ');
            }
        }
        out.push_str(text);
    }
    out
}

pub fn resolve(doc_id: &str, page: i64, quote: &str, lines: &[Line]) -> Option<Evidence> {
    let alvo = ai::normalize(quote);
    if alvo.chars().count() < 8 || lines.is_empty() {
        return None;
    }

    // Primeiro tenta casar o texto exato. Se a IA trocou uma palavra ("coligiu"
    // por "coligidas"), cai no alinhamento por palavras.
    let (first, last) = match exact_span(quote, lines) {
        Some(span) => span,
        None => fuzzy_span(quote, lines)?,
    };
    if first > last || last >= lines.len() {
        return None;
    }

    // Descarta linhas vazias nas pontas (podem sobrar do casamento).
    let mut a = first;
    let mut b = last;
    while a <= b && lines[a].text.trim().is_empty() {
        a += 1;
    }
    while b > a && lines[b].text.trim().is_empty() {
        b -= 1;
    }
    if a > b || lines[a].text.trim().is_empty() {
        return None;
    }
    let window = &lines[a..=b];

    Some(Evidence {
        id: format!("{doc_id}:{page}:{a}-{b}"),
        doc_id: doc_id.to_string(),
        page,
        text: join_lines(window),
        rects: window
            .iter()
            .filter(|l| !l.text.trim().is_empty())
            .map(|l| l.rect)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(i: i64, text: &str, y: f64) -> Line {
        Line {
            i,
            text: text.into(),
            rect: [72.0, y, 350.0, y + 12.0],
        }
    }

    fn lines_of(texts: &[&str]) -> Vec<Line> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| line(i as i64, t, 700.0 - 12.0 * i as f64))
            .collect()
    }

    #[test]
    fn destaca_apenas_as_duas_linhas_citadas() {
        let lines = vec![
            line(0, "primeira linha que nao interessa", 700.0),
            line(1, "As entrevistas semiestruturadas foram aplicadas", 680.0),
            line(2, "com 30 professores da rede municipal.", 668.0),
            line(3, "outra linha que nao interessa", 640.0),
        ];
        let found = resolve("d1", 7, "entrevistas semiestruturadas foram aplicadas com 30 professores", &lines)
            .expect("deveria achar");
        assert_eq!(found.rects.len(), 2);
        assert!(found.id.starts_with("d1:7:1-2"));
        assert!(found.text.contains("30 professores"));
    }

    #[test]
    fn aceita_quote_com_hifen_quebrado() {
        let lines = vec![
            line(0, "texto anterior", 700.0),
            line(1, "the cost- effective method was used in the", 680.0),
            line(2, "experiment.", 668.0),
        ];
        let found = resolve("d1", 2, "cost-effective method was used", &lines).expect("deveria achar");
        assert_eq!(found.rects.len(), 1);
    }

    #[test]
    fn palavra_hifenizada_no_fim_da_linha_casa_na_linha_seguinte() {
        // Quebra de linha no meio da palavra, como nos PDFs de revista: "pes-" / "quisadores".
        let lines = lines_of(&[
            "Os dados foram analisados por dois pes-",
            "quisadores independentes, que discor-",
            "daram em apenas 3% dos casos.",
            "Outro paragrafo sem relacao.",
        ]);
        let found = resolve(
            "d1",
            4,
            "analisados por dois pesquisadores independentes, que discordaram em apenas 3% dos casos",
            &lines,
        )
        .expect("quote sem hífen deve casar com texto hifenizado");
        assert_eq!(found.rects.len(), 3);
        assert!(found.id.ends_with(":0-2"));
        assert!(found.text.contains("pesquisadores") && found.text.contains("discordaram"), "{}", found.text);
    }

    #[test]
    fn hifen_de_composto_na_quebra_tambem_casa() {
        let lines = lines_of(&["a abordagem custo-", "efetividade foi adotada em todos os centros de saude"]);
        assert!(resolve("d1", 1, "abordagem custo-efetividade foi adotada", &lines).is_some());
        assert!(resolve("d1", 1, "abordagem custo efetividade foi adotada", &lines).is_some());
    }

    #[test]
    fn ligaturas_do_pdf_casam_com_a_quote_do_modelo() {
        let lines = lines_of(&[
            "A diferença foi estatisticamente signiﬁcativa",
            "e o eﬁciente uso do ﬂuxo de caixa mostrou",
        ]);
        let found = resolve("d1", 3, "estatisticamente significativa e o eficiente uso do fluxo de caixa", &lines)
            .expect("ligaturas");
        assert_eq!(found.rects.len(), 2);
    }

    #[test]
    fn acentos_decompostos_no_pdf() {
        let lines = lines_of(&["A forma\u{0327}a\u{0303}o continuada de professores e a", "pra\u{0301}tica pedago\u{0301}gica na escola."]);
        let found = resolve("d1", 1, "formação continuada de professores e a prática pedagógica", &lines).expect("NFD");
        assert_eq!(found.rects.len(), 2);
    }

    #[test]
    fn duas_colunas_destaca_so_a_coluna_citada() {
        // O extrator entrega linhas da coluna esquerda e depois da direita, cada uma com seu retângulo.
        let mut lines = lines_of(&[
            "Coluna esquerda linha um do texto",
            "Coluna esquerda linha dois do texto",
        ]);
        lines.push(Line { i: 2, text: "A coleta de dados ocorreu entre março".into(), rect: [320.0, 700.0, 540.0, 712.0] });
        lines.push(Line { i: 3, text: "e junho de 2023 em quatro escolas.".into(), rect: [320.0, 688.0, 540.0, 700.0] });
        let found = resolve("d1", 2, "coleta de dados ocorreu entre março e junho de 2023", &lines).unwrap();
        assert_eq!(found.rects.len(), 2);
        assert!(found.rects.iter().all(|r| r[0] >= 320.0));
    }

    #[test]
    fn aceita_palavra_flexionada_pela_ia() {
        let lines = vec![
            line(0, "INTRODUCAO", 750.0),
            line(1, "Neste levantamento, foram coligidas 258 pesquisas - 31 teses de doutorado e 227 dissertacoes de", 720.0),
            line(2, "mestrado -, produzidas em 56 universidades brasileiras.", 708.0),
            line(3, "O criterio adotado para compor o inventario foi outro.", 690.0),
        ];
        let found = resolve(
            "d1",
            2,
            "coligiu 258 pesquisas - 31 teses de doutorado e 227 dissertacoes de mestrado -, produzidas em 56 universidades brasileiras",
            &lines,
        )
        .expect("deveria achar mesmo com o verbo trocado");
        assert_eq!(found.rects.len(), 2);
        assert_eq!(found.id, "d1:2:1-2");
    }

    #[test]
    fn alinhamento_tolerante_acha_trecho_no_fim_de_pagina_longa() {
        // Antes o alinhamento só olhava o começo da página.
        let mut texts: Vec<String> = (0..60)
            .map(|i| format!("linha {i} de texto corrente sobre formacao docente e curriculo escolar brasileiro"))
            .collect();
        texts.push("Os resultados indicaram que a maioria dos professores participantes relatou".into());
        texts.push("insegurança ao ensinar probabilidade nos anos iniciais do ensino fundamental.".into());
        texts.push("linha final sem importancia".into());
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let lines = lines_of(&refs);
        // IA trocou "relatou" por "relataram" e "insegurança" por "inseguranças"
        let found = resolve(
            "d1",
            9,
            "a maioria dos professores participantes relataram inseguranças ao ensinar probabilidade nos anos iniciais",
            &lines,
        )
        .expect("deveria achar no fim da página");
        assert_eq!(found.rects.len(), 2);
        assert_eq!(found.id, "d1:9:60-61");
    }

    #[test]
    fn palavra_comum_espalhada_pela_pagina_nao_vira_destaque() {
        let texts: Vec<String> = (0..40)
            .map(|i| format!("o resultado de uma analise foi que a amostra {i} em geral"))
            .collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let lines = lines_of(&refs);
        assert!(resolve("d1", 1, "o modelo de regressão logística mostrou que a amostra em geral", &lines).is_none());
    }

    #[test]
    fn nao_inventa_evidencia() {
        let lines = vec![line(0, "nada a ver", 700.0)];
        assert!(resolve("d1", 1, "passagem que nao existe no texto", &lines).is_none());
    }

    #[test]
    fn entradas_degeneradas_nao_causam_panico() {
        assert!(resolve("d1", 1, "qualquer citação longa o bastante", &[]).is_none());
        assert!(resolve("d1", 1, "", &lines_of(&["texto"])).is_none());
        assert!(resolve("d1", 1, "curta", &lines_of(&["curta"])).is_none());
        // página só com linhas vazias
        let vazias = lines_of(&["", "  ", ""]);
        assert!(resolve("d1", 1, "citação longa o bastante para tentar", &vazias).is_none());
        // quote só com hífens e espaços
        assert!(resolve("d1", 1, "- - - - - - - - - - -", &lines_of(&["a - b"])).is_none());
        // quote com emoji e CJK
        let lines = lines_of(&["análise 日本語のテキスト 😀 concluída com sucesso hoje"]);
        assert!(resolve("d1", 1, "日本語のテキスト 😀 concluída com sucesso", &lines).is_some());
    }

    #[test]
    fn linhas_vazias_nas_pontas_sao_descartadas() {
        let lines = lines_of(&["", "A taxa de evasão foi de 12% no período", "", "outra coisa"]);
        let found = resolve("d1", 1, "taxa de evasão foi de 12% no período", &lines).unwrap();
        assert_eq!(found.rects.len(), 1);
        assert_eq!(found.id, "d1:1:1-1");
    }

    #[test]
    fn linha_vazia_no_meio_do_trecho_nao_gera_retangulo() {
        let lines = lines_of(&["A taxa de evasão foi", "", "de 12% no período letivo"]);
        let found = resolve("d1", 1, "taxa de evasão foi de 12% no período", &lines).unwrap();
        assert_eq!(found.rects.len(), 2);
    }
}
