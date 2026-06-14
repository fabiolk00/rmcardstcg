import styles from "./WhatsAppFab.module.css";

const MESSAGE = "Olá, vim pelo site da RM Cards!";

// Mock-first: so renderiza quando a env estiver preenchida (integracao atras de guarda).
export function WhatsAppFab() {
  const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  if (!number) return null;

  const href = `https://wa.me/${number}?text=${encodeURIComponent(MESSAGE)}`;

  return (
    <a
      className={styles.fab}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Falar no WhatsApp"
    >
      <span className={styles.pulse} aria-hidden="true" />
      <svg width="28" height="28" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
        <path d="M16.002 3C9.374 3 4 8.373 4 14.998c0 2.353.69 4.643 2 6.625L4 29l7.55-1.98a11.97 11.97 0 0 0 4.45.85h.005C22.628 27.87 28 22.498 28 15.873c0-3.196-1.245-6.2-3.505-8.459A11.917 11.917 0 0 0 16.002 3zm0 21.86h-.004a9.93 9.93 0 0 1-5.057-1.385l-.363-.215-4.481 1.175 1.196-4.366-.236-.376a9.918 9.918 0 0 1-1.522-5.295c0-5.483 4.464-9.943 9.969-9.943 2.66 0 5.159 1.036 7.04 2.917a9.886 9.886 0 0 1 2.92 7.036c0 5.482-4.464 9.948-9.962 9.948zm5.466-7.444c-.299-.15-1.77-.873-2.045-.972-.275-.1-.475-.15-.674.15-.2.298-.774.972-.948 1.171-.175.2-.349.225-.648.075-.299-.15-1.263-.466-2.405-1.485-.889-.793-1.488-1.773-1.663-2.072-.175-.299-.019-.46.131-.609.135-.135.299-.349.449-.524.15-.175.2-.299.299-.498.1-.2.05-.374-.025-.524-.075-.15-.674-1.626-.924-2.226-.243-.583-.49-.504-.674-.514l-.574-.01a1.1 1.1 0 0 0-.798.374c-.274.299-1.048 1.024-1.048 2.5 0 1.475 1.073 2.901 1.222 3.1.15.2 2.113 3.228 5.122 4.527.715.309 1.273.494 1.708.633.717.228 1.37.196 1.886.119.575-.086 1.77-.723 2.02-1.422.25-.7.25-1.298.175-1.422-.075-.124-.275-.2-.574-.349z" />
      </svg>
    </a>
  );
}
