// Tema do Clerk alinhado aos design tokens (monocromatico ink). Valores concretos
// porque o appearance do Clerk nao resolve var() de CSS. Tipagem validada no uso
// (prop appearance do ClerkProvider).
export const clerkAppearance = {
  variables: {
    colorPrimary: "#0a0a0a",
    colorText: "#0a0a0a",
    colorTextSecondary: "#4a4a4a",
    colorBackground: "#ffffff",
    colorInputText: "#0a0a0a",
    colorInputBackground: "#ffffff",
    colorDanger: "#d32f2f",
    colorSuccess: "#16a34a",
    borderRadius: "8px",
    fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
};
