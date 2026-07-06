import type { Metadata } from "next";

import { LegalDoc, type LegalSection } from "@/components/legal/LegalDoc";

export const metadata: Metadata = {
  title: "Política de Privacidade — RM Cards",
  description:
    "Como a RM Cards coleta, usa, protege e compartilha dados pessoais na loja, em conformidade com a LGPD.",
};

// NOTA: conteudo fornecido pelo lojista. E-mail (rmcardstcg@gmail.com), CNPJ e a
// lista de operadores (§6) ja refletem o stack REAL: Clerk (auth), Supabase
// (DB+Storage), Vercel, Asaas, SuperFrete, Resend. Sem analytics/Upstash/SendGrid.
// Pendente so: razao social registrada sob o CNPJ (usamos o nome-fantasia
// "RM Cards") e uma revisao juridica final.
const sections: LegalSection[] = [
  {
    heading: "1. Introdução",
    blocks: [
      'Nossa empresa ("nós", "nosso" ou "empresa") opera uma plataforma de e-commerce para venda de produtos e serviços (o "Serviço"). Esta Política descreve como tratamos dados pessoais quando você acessa, faz compras ou utiliza a plataforma, em conformidade com a Lei Geral de Proteção de Dados (LGPD - Lei nº 13.709/2018).',
      "Esta é uma política de privacidade objetiva, em linguagem acessível. Sempre que houver conflito entre esta Política e termos específicos aplicáveis a determinado produto, contrato ou jurisdição, prevalecerá o documento mais protetivo ao titular.",
    ],
  },
  {
    heading: "2. Controlador e Encarregado (DPO)",
    blocks: [
      "Para os fins do art. 5º, VI, da LGPD, a RM Cards (CNPJ 65.537.204/0001-01) é a controladora dos dados pessoais tratados no Serviço.",
      "O canal do Encarregado pelo Tratamento de Dados Pessoais (DPO) é rmcardstcg@gmail.com. Use esse e-mail para exercer direitos do titular, tirar dúvidas ou registrar incidentes de privacidade.",
    ],
  },
  {
    heading: "3. Dados que coletamos",
    blocks: [
      "Tratamos os seguintes grupos de dados pessoais:",
      {
        list: [
          "Dados de cadastro e autenticação: nome, e-mail, identificador de usuário no provedor de autenticação (Clerk) e metadados de sessão. As credenciais (senha) são geridas diretamente pela Clerk; não armazenamos senhas.",
          "Dados de endereço e entrega: nome completo, telefone, CEP, endereço, número, complemento, bairro, cidade, estado. Utilizados exclusivamente para processamento de pedidos e entrega.",
          "Dados de pagamento: Nenhum dado de cartão é armazenado. Apenas recebemos da Asaas um token criptografado, ID de transação, status do pagamento e últimos 4 dígitos.",
          "Dados de perfil e preferências: foto de perfil (opcional), data de nascimento (se fornecida), histórico de pedidos, itens salvos, preferências de comunicação.",
          "Dados de uso, telemetria e logs: endereços IP, identificadores de dispositivo, eventos de navegação, falhas e erros técnicos, duração de sessão.",
          'Dados de cookies e tecnologias similares: conforme descrito na seção "Cookies".',
          "Dados de comunicação: e-mails trocados, tickets de suporte, feedback e avaliações de produtos.",
        ],
      },
      "Não coletamos intencionalmente dados sensíveis (origem racial, religião, saúde, biometria etc.). Se você incluir tais informações voluntariamente, você o faz por iniciativa própria.",
    ],
  },
  {
    heading: "4. Finalidades do tratamento",
    blocks: [
      "Utilizamos seus dados para:",
      {
        list: [
          "Operar o Serviço, autenticar acessos e gerenciar sua conta.",
          "Processar pedidos, gerar faturas e entregar produtos.",
          "Processar pagamentos através da Asaas, gerenciar devoluções e reembolsos.",
          "Enviar confirmações, atualizações de entrega e comunicações transacionais.",
          "Prevenir fraude, abuso e garantir a segurança da plataforma.",
          "Cumprir obrigações legais, regulatórias e responder a autoridades.",
          "Melhorar o produto e serviço através de análise agregada (com consentimento).",
          "Enviar comunicações de marketing, promoções e ofertas (apenas com consentimento).",
        ],
      },
    ],
  },
  {
    heading: "5. Bases legais (LGPD art. 7º)",
    blocks: [
      "O tratamento se apoia nas seguintes bases legais:",
      {
        list: [
          "Execução de contrato (art. 7º, V): dados necessários para entregar o Serviço — cadastro, pedidos, cobrança, entrega.",
          "Cumprimento de obrigação legal (art. 7º, II): retenção de notas fiscais, comprovantes de entrega e registros de transação.",
          "Legítimo interesse (art. 7º, IX): segurança da plataforma, prevenção a fraude, detecção de atividade anômala, melhoria operacional.",
          "Consentimento (art. 7º, I): cookies de análise e marketing, comunicações opcionais, análise estatística agregada.",
        ],
      },
    ],
  },
  {
    heading: "6. Com quem compartilhamos",
    blocks: [
      "A empresa não vende dados pessoais. Compartilhamos com operadores terceiros estritamente para viabilizar o Serviço:",
      {
        list: [
          "Clerk: autenticação, gestão de contas e sessões.",
          "Supabase: banco de dados PostgreSQL e armazenamento de imagens de produtos (Storage).",
          "Vercel: hospedagem da aplicação web, edge runtime, logs e monitoramento.",
          "Asaas: processamento de pagamentos (PIX, cartão, boleto) e emissão de cobranças. Asaas cumpre PCI-DSS e LGPD.",
          "SuperFrete: cálculo de frete e emissão de etiquetas, intermediando Correios e transportadoras para a entrega física.",
          "Resend: envio de e-mails transacionais (confirmação de pedido e de pagamento, notificações).",
        ],
      },
      "Esses parceiros atuam como operadores, com obrigações contratuais de confidencialidade e segurança. Alguns processam dados fora do Brasil, com garantias compatíveis com arts. 33 a 36 da LGPD.",
    ],
  },
  {
    heading: "7. Cookies e consentimento",
    blocks: [
      "Usamos três categorias de cookies:",
      {
        list: [
          "Essenciais: autenticação, segurança da sessão, carrinho de compras, preferências de interface. Não dependem de consentimento.",
          "Funcionais e de análise: ajudam a entender o uso, medir desempenho, melhorar experiência. Só após consentimento via banner.",
          "Marketing: rastreamento de conversões, análise de origem, remarketing. Somente com consentimento.",
        ],
      },
      "Você pode revisar sua escolha em Configurações > Privacidade ou limpando cookies. O consentimento fica armazenado por até 12 meses.",
    ],
  },
  {
    heading: "8. Retenção e eliminação",
    blocks: [
      "Mantemos seus dados pelo tempo necessário para cumprir as finalidades:",
      {
        list: [
          "Dados de conta: enquanto conta ativa, depois 30 dias para recuperação, então eliminamos (salvo obrigação legal).",
          "Dados de pedidos/faturas: retidos por 7 anos conforme exigência fiscal.",
          "Dados de pagamento tokenizados: retidos para reembolsos, tipicamente 180 dias após transação.",
          "Logs de segurança: armazenados por 12 meses para auditoria, depois descartados.",
          "Cookies e analíticos: agregados e anonimizados conforme políticas dos provedores.",
        ],
      },
      "Após esses períodos, dados são eliminados, anonimizados ou bloqueados conforme art. 16 da LGPD.",
    ],
  },
  {
    heading: "9. Direitos do titular (LGPD art. 18)",
    blocks: [
      "Como titular, você pode exercer:",
      {
        list: [
          "Confirmação da existência de tratamento",
          "Acesso aos dados",
          "Correção de dados incompletos ou inexatos",
          "Anonimização, bloqueio ou eliminação",
          "Portabilidade",
          "Eliminação (esquecimento)",
          "Informação sobre compartilhamento",
          "Informação sobre recusa",
          "Revogação do consentimento",
        ],
      },
      "Você pode exercer estes direitos em Configurações > Privacidade ou enviando solicitação para rmcardstcg@gmail.com. Responderemos no prazo de lei (até 15 dias úteis).",
    ],
  },
  {
    heading: "10. Segurança da informação",
    blocks: [
      "Adotamos medidas técnicas e organizacionais:",
      {
        list: [
          "Criptografia em trânsito (TLS 1.3)",
          "Criptografia em repouso para dados sensíveis",
          "Controle de acesso baseado em identidade",
          "Isolamento de rede",
          "Auditoria e logs de acessos",
          "Backup automático diário",
        ],
      },
      "Nenhum sistema é totalmente imune a incidentes. Em caso de breach relevante, comunicaremos a ANPD e titulares conforme art. 48 da LGPD.",
    ],
  },
  {
    heading: "11. Crianças e adolescentes",
    blocks: [
      "O Serviço não é direcionado a menores de 18 anos. Se for responsável e identificar que um menor criou conta sem seu consentimento, contate o DPO para remoção.",
    ],
  },
  {
    heading: "12. Alterações desta Política",
    blocks: [
      "Podemos atualizar esta Política periodicamente. Mudanças relevantes serão comunicadas com antecedência por e-mail e/ou aviso destacado na plataforma. A data no topo sempre reflete a versão vigente.",
    ],
  },
  {
    heading: "13. Contato",
    blocks: [
      "Dúvidas sobre privacidade ou solicitações relativas à LGPD podem ser encaminhadas ao DPO em rmcardstcg@gmail.com. Para suporte geral, escreva para rmcardstcg@gmail.com.",
    ],
  },
];

export default function PoliticaDePrivacidadePage() {
  return (
    <LegalDoc
      eyebrow="Legal"
      title="Política de Privacidade"
      updated="Última atualização: janeiro de 2026"
      lead="Entenda como coletamos, usamos, protegemos e compartilhamos dados pessoais na prestação dos nossos serviços de e-commerce, em conformidade com a LGPD."
      sections={sections}
      footer="Todos os direitos reservados."
    />
  );
}
