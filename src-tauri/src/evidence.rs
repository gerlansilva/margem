use crate::ai;
use crate::model::{Evidence, Line};

/// Acha a menor sequência contígua de linhas cujo texto contém a citação.
/// Devolve o texto original das linhas e os retângulos de cada uma — é isso que
/// permite destacar só as linhas certas no PDF, inclusive em duas colunas.
/// Casamento exato no texto concatenado da página.
fn exact_span(quote: &str, lines: &[Line]) -> Option<(usize, usize)> {
    let alvo = ai::normalize(quote);
    let mut joined = String::new();
    let mut offsets = Vec::with_capacity(lines.len());
    for line in lines {
        let normalized = ai::normalize(&line.text);
        offsets.push((joined.len(), joined.len() + normalized.len()));
        joined.push_str(&normalized);
        joined.push(' ');
    }
    let inicio = joined.find(&alvo)?;
    let fim = inicio + alvo.len();

    // Primeira linha que começa depois do início e última que termina antes do fim.
    let mut first = None;
    let mut last = None;
    for (index, (start, end)) in offsets.iter().enumerate() {
        if *end > inicio && first.is_none() {
            first = Some(index);
        }
        if *start < fim {
            last = Some(index);
        }
    }
    Some((first?, last?))
}

/// Alinhamento tolerante: casa a citação palavra por palavra, ignorando
/// diferenças de flexão e pontuação que a IA costuma introduzir. Exige que 70%
/// das palavras apareçam na ordem, senão devolve `None` — citação inventada não
/// vira destaque.
fn fuzzy_span(quote: &str, lines: &[Line]) -> Option<(usize, usize)> {
    let alvo: Vec<String> = ai::normalize(quote)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if alvo.len() < 5 {
        return None;
    }
    let mut page: Vec<(String, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let normalized = ai::normalize(&line.text);
        for token in normalized.split_whitespace() {
            page.push((token.to_string(), index));
        }
    }
    if page.is_empty() {
        return None;
    }

    let mut best: Option<(usize, usize, usize)> = None; // acertos, primeira linha, última
    // A citação pode começar no meio da linha e a IA pode ter errado a primeira
    // palavra; tenta entrar por até três posições do começo.
    for skip in 0..alvo.len().min(4) {
        let mut qi = skip;
        let mut matched = 0;
        let mut first_if = None;
        let mut last_if = skip;
        let budget = (alvo.len() * 3 + 12).min(page.len());
        for (pi, (token, _line_index)) in page.iter().enumerate().take(budget) {
            if qi >= alvo.len() {
                break;
            }
            if token == &alvo[qi] {
                first_if.get_or_insert(pi);
                last_if = pi;
                matched += 1;
                qi += 1;
            }
        }
        let Some(start) = first_if else { continue };
        // 70% das palavras da citação, no mínimo, pelo menos cinco acertos, e
        // tudo dentro de poucas linhas: palavra comum espalhada pela página não
        // pode virar uma citação de dez linhas.
        let spread = page[last_if].1 - page[start].1;
        if matched >= 5
            && matched * 10 >= alvo.len() * 7
            && spread <= alvo.len() / 2 + 2
            && last_if - start <= alvo.len() * 2
        {
            let span = (matched, page[start].1, page[last_if].1);
            if best.map_or(true, |b| span.0 > b.0 || (span.0 == b.0 && span.2 - span.1 < b.2 - b.1)) {
                best = Some(span);
            }
        }
    }
    let (_, first, last) = best?;
    Some((first, last))
}

pub fn resolve(doc_id: &str, page: i64, quote: &str, lines: &[Line]) -> Option<Evidence> {
    let alvo = ai::normalize(quote);
    if alvo.len() < 8 || lines.is_empty() {
        return None;
    }

    // Primeiro tenta casar o texto exato. Se a IA trocou uma palavra ("coligiu"
    // por "coligidas"), cai no alinhamento por palavras.
    let (first, last) = match exact_span(quote, lines) {
        Some(span) => span,
        None => fuzzy_span(quote, lines)?,
    };

    // Descarta linhas vazias nas pontas (podem sobrar do casamento).
    let mut a = first;
    let mut b = last;
    while a <= b && lines[a].text.trim().is_empty() {
        a += 1;
    }
    while b >= a && lines[b].text.trim().is_empty() {
        b -= 1;
    }
    let window = &lines[a..=b];
    if window.is_empty() {
        return None;
    }

    Some(Evidence {
        id: format!("{doc_id}:{page}:{a}-{b}"),
        doc_id: doc_id.to_string(),
        page,
        text: window
            .iter()
            .map(|l| l.text.trim())
            .collect::<Vec<_>>()
            .join(" "),
        rects: window.iter().map(|l| l.rect).collect(),
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
    fn nao_inventa_evidencia() {
        let lines = vec![line(0, "nada a ver", 700.0)];
        assert!(resolve("d1", 1, "passagem que nao existe no texto", &lines).is_none());
    }
}
