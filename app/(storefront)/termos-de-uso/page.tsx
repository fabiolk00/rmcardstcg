import type { Metadata } from "next";

import { LegalDoc, type LegalSection } from "@/components/legal/LegalDoc";

export const metadata: Metadata = {
  title: "Termos de Uso — RM Cards",
  description:
    "Termos e condições de uso da loja RM Cards: conta, pedidos, pagamentos, entrega, devoluções e responsabilidades.",
};

// NOTA (revisar antes de publicar): conteudo fornecido pelo lojista, transcrito
// verbatim. E-mail (rmcardstcg@gmail.com) e CNPJ (65.537.204/0001-01) ja reais.
// Confirmar ainda: foro (Curitiba/PR confere com o FROM_CEP) e a razao social
// registrada sob o CNPJ (aqui usamos o nome-fantasia "RM Cards").
const sections: LegalSection[] = [
  {
    heading: "1. Aceitação dos Termos",
    blocks: [
      "Ao acessar ou utilizar a plataforma de e-commerce da RM Cards (CNPJ 65.537.204/0001-01), incluindo o site, aplicação web e qualquer API associada, você declara ter lido, compreendido e concordado com estes Termos de Uso em sua totalidade. Se utilizando em nome de uma empresa ou organização, declara ter autoridade para vincular tal entidade.",
      "Caso não concorde com qualquer parte, você não está autorizado a utilizar os serviços. O uso continuado após publicação de alterações constitui aceitação das versões revisadas.",
    ],
  },
  {
    heading: "2. Descrição dos Serviços",
    blocks: [
      "A plataforma é um e-commerce para venda de produtos e serviços digitais e físicos. Os serviços incluem:",
      {
        list: [
          "Catálogo de produtos: navegação, busca, filtros e detalhes.",
          "Carrinho de compras: seleção, cálculo de frete, cupons e códigos promocionais.",
          "Processamento de pedidos: confirmação de endereço, pagamento, emissão de nota fiscal.",
          "Pagamentos: integração com Asaas para cartão, débito, PIX e boleto.",
          "Entrega: rastreamento, atualização de status, integração com transportadoras.",
          "Conta do usuário: histórico de pedidos, endereços salvos, perfil, preferências.",
          "Suporte: canais de contato para dúvidas e reclamações.",
        ],
      },
      "A empresa se reserva o direito de modificar, suspender ou descontinuar qualquer funcionalidade a qualquer momento, mediante notificação razoável.",
    ],
  },
  {
    heading: "3. Conta e Acesso",
    blocks: [
      "Para utilizar certos recursos (carrinho, histórico, checkout) é necessário criar uma conta. Você é responsável por manter confidencialidade de suas credenciais e por todas as atividades realizadas sob sua conta.",
      "Você concorda em: fornecer informações verdadeiras e precisas; notificar imediatamente sobre uso não autorizado; não compartilhar credenciais; fazer logout em dispositivos compartilhados.",
      "A empresa se reserva o direito de suspender ou encerrar contas que violem estes termos, apresentem atividade suspeita, ou permaneçam inativas por 24+ meses.",
    ],
  },
  {
    heading: "4. Processamento de Pedidos e Compras",
    blocks: [
      'Ao realizar uma compra, você está oferecendo uma proposta de contrato. A aceitação ocorre quando você clica em "Confirmar Pedido" e recebe e-mail de confirmação. A empresa se reserva o direito de rejeitar ou cancelar pedidos por fraude, falta de estoque ou erro de preço.',
      "Preços e disponibilidade: preços estão sujeitos a alteração. Produtos estão disponíveis enquanto exibidos no catálogo. Em caso de falta de estoque após confirmação, entraremos em contato para oferecer alternativas.",
      "Quantidade limite: a empresa pode impor limite de quantidade por cliente para evitar revenda.",
    ],
  },
  {
    heading: "5. Pagamentos e Processamento",
    blocks: [
      "Todos os pagamentos são processados pela Asaas, plataforma certificada PCI-DSS. A empresa não armazena informações completas de cartão. Você autoriza a cobrança ao confirmar o pedido.",
      "Métodos aceitos: PIX e cartão de crédito à vista. Outros métodos poderão ser disponibilizados futuramente.",
      "Validade das transações: pedidos são processados em tempo real. Se houver recusa, será notificado para tentar novamente.",
      "Cartão de crédito: a cobrança é feita à vista (sem parcelamento nesta versão). Caso o parcelamento seja disponibilizado, as condições estarão explícitas no checkout.",
      "Chargeback: em caso de chargeback indevido, a empresa poderá suspender a conta e iniciar procedimento legal.",
    ],
  },
  {
    heading: "6. Frete e Entrega",
    blocks: [
      "Fretes são calculados em tempo real com base em CEP, peso, dimensões e transportadora. Prazos são estimativas e não garantidos.",
      "A entrega é realizada por transportadoras parceiras. Rastreamento é fornecido via código de postagem. Reclamações devem ser registradas à transportadora.",
      "A empresa não se responsabiliza por atrasos causados por transportadora, clima, greves ou erros no endereço fornecido pelo cliente.",
      "Endereço incompleto ou incorreto: se fornecido errado, a transportadora tenta entrega. Se não conseguir, o pacote retorna. Você arcará com custo de reenvio.",
      "Assinatura e recusa: entregas podem exigir assinatura. Se você recusar recebimento, o pacote é retornado às suas custas.",
    ],
  },
  {
    heading: "7. Devoluções e Reembolsos",
    blocks: [
      "O direito de devolução está regulado pela Política de Reembolso e pelas leis de proteção do consumidor (Lei 8.078/1990 - CDC).",
      "Prazo: você tem até 7 dias corridos após recebimento para solicitar devolução (aplicável a compras online conforme CDC). Produtos defeituosos podem ser devolvidos a qualquer tempo.",
      "Condições: produto deve estar íntegro, sem sinais de uso, com embalagem original e acessórios.",
      "Reembolso: após análise da devolução, reembolso é processado via mesmo método de pagamento em até 10 dias úteis.",
      "Frete de devolução: customer paga frete para devolver. Se produto estiver defeituoso (nossa culpa), a empresa custeia o retorno.",
      "Produtos personalizados ou digitais: geralmente não são devolvíveis após entrega (conforme sinalizado no catálogo).",
    ],
  },
  {
    heading: "8. Conteúdo do Usuário e Avaliações",
    blocks: [
      'Você poderá submeter comentários, avaliações, fotos e feedback sobre produtos ("Conteúdo do Usuário"). Você mantém titularidade desse conteúdo.',
      "Ao submeter, você concede à empresa uma licença limitada, não exclusiva, isenta de royalties e irrevogável para utilizar esse conteúdo na plataforma, em marketing e análise de produto, respeitando sua privacidade.",
      "Você declara ser o detentor de direitos e que publicação não viola direitos de terceiros.",
      "Moderação: a empresa se reserva o direito de recusar, remover ou editar conteúdo que:",
      {
        list: [
          "Contenha linguagem obscena, difamatória, ofensiva ou discriminatória",
          "Seja spam, propaganda de outros sites ou produtos concorrentes",
          "Viole direitos de terceiros ou legislação",
          "Seja falso, enganoso ou prejudicial à reputação",
        ],
      },
      "Conteúdo removido não gera direito a indenização ou reembolso.",
    ],
  },
  {
    heading: "9. Privacidade e Dados",
    blocks: [
      "O tratamento de dados pessoais é regido pela nossa Política de Privacidade, incorporada a estes Termos por referência. Ao utilizar os serviços, você consente com coleta e uso de dados conforme descrito.",
      "A empresa adota medidas técnicas e organizacionais adequadas para proteger seus dados contra acesso não autorizado.",
      "Em conformidade com a LGPD, você pode solicitar acesso, correção, portabilidade ou exclusão dos seus dados em rmcardstcg@gmail.com.",
    ],
  },
  {
    heading: "10. Propriedade Intelectual",
    blocks: [
      "A plataforma, incluindo código-fonte, design, marca, logotipos, conteúdo editorial e imagens, é de propriedade exclusiva da empresa e está protegida pelas leis brasileiras e internacionais.",
      "Estes termos não transferem ao usuário nenhum direito de propriedade. É concedida apenas uma licença limitada, não exclusiva e intransferível para usar a plataforma conforme descrito, exclusivamente para fins pessoais (não comerciais).",
      "É vedado: reproduzir, distribuir ou revender a plataforma; extrair dados em massa (scraping); fazer engenharia reversa; criar versões derivadas.",
    ],
  },
  {
    heading: "11. Uso Aceitável",
    blocks: [
      "Você concorda em não utilizar a plataforma para:",
      {
        list: [
          "Fraude: realizar compras com cartão, dados ou conta de terceiros; usar informações falsas.",
          "Hacking: contornar autenticação, explorar vulnerabilidades, força bruta, injetar código malicioso.",
          "Abuso: assediar usuários, criar contas falsas em massa, spam, desinformação.",
          "Revenda: vender itens como serviço de terceiros; usar cupons fraudulentamente.",
          "Violação de direitos: submeter conteúdo que viole copyrights, marcas ou privacidade.",
          "Scraping: usar bots, scripts ou ferramentas não autorizadas para extrair dados.",
          "Interferência: realizar ataques DDoS, flooding ou qualquer ataque que prejudique disponibilidade.",
        ],
      },
      "Violação destas regras pode resultar em suspensão, encerramento, bloqueio de pagamentos e responsabilidade legal.",
    ],
  },
  {
    heading: "12. Limitação de Responsabilidade",
    blocks: [
      "Na máxima extensão permitida pela legislação, a empresa não será responsável por danos indiretos, incidentais, especiais, consequenciais ou punitivos, incluindo perda de lucros, dados, oportunidades comerciais.",
      "A responsabilidade total da empresa não excederá o valor pago pelo usuário nos 3 meses anteriores ao evento.",
      "Indisponibilidade: a empresa não se responsabiliza por interrupções de serviço, perda de dados durante falhas técnicas, erros de terceiros ou eventos de força maior.",
    ],
  },
  {
    heading: "13. Garantia de Produtos",
    blocks: [
      "A garantia segue o indicado em cada anúncio, a legislação de consumidor brasileira (CDC) e políticas dos fabricantes. Defeitos de fabricação são cobertos; defeitos por uso indevido, dano acidental ou desgaste natural não.",
      "Para acionar garantia, contate rmcardstcg@gmail.com dentro do prazo indicado (geralmente 12 meses). Será necessário comprovante de compra e descrição do problema.",
    ],
  },
  {
    heading: "14. Alterações nos Termos",
    blocks: [
      "A empresa pode revisar estes Termos periodicamente. Quando alterações relevantes forem feitas, você será notificado por e-mail ou aviso destacado com antecedência mínima de 15 dias.",
      "A continuidade do uso após a vigência constitui aceitação dos novos termos. Se não concordar, você deve encerrar sua conta antes da vigência.",
    ],
  },
  {
    heading: "15. Lei Aplicável e Foro",
    blocks: [
      "Estes Termos são regidos e interpretados de acordo com as leis da República Federativa do Brasil, particularmente a Lei 8.078/1990 (CDC) e Lei 13.709/2018 (LGPD).",
      "Qualquer disputa será submetida à jurisdição exclusiva do Foro da Comarca de Curitiba, Estado do Paraná, com renúncia expressa a qualquer outro foro.",
      "Para questões relacionadas a estes termos, contate rmcardstcg@gmail.com.",
    ],
  },
];

export default function TermosDeUsoPage() {
  return (
    <LegalDoc
      eyebrow="Legal"
      title="Termos de Uso"
      updated="Última atualização: janeiro de 2026"
      lead="Ao criar uma conta na plataforma você concorda em estar vinculado aos nossos Termos de Uso."
      sections={sections}
      footer="Todos os direitos reservados."
    />
  );
}
