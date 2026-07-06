"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { AdminUser, Role } from "@/lib/data/users";
import { Icon } from "@/components/ui/Icon";
import { Pagination } from "@/components/ui/Pagination";
import { setUserRoleAction } from "@/app/admin/usuarios/actions";
import styles from "./AdminUsersView.module.css";

const PER_PAGE = 10;
const ROLES: { value: Role; label: string }[] = [
  { value: "cliente", label: "Cliente" },
  { value: "admin", label: "Admin" },
];

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * Lista de usuarios do admin com troca de role auditada (item #3). Espelha a
 * arquitetura/estilo de AdminCouponsView: estado local sincronizado ao revalidar,
 * busca por e-mail, mutacao via useTransition + toast.
 *
 * Guarda anti-lockout: o controle de role e DESABILITADO na linha do proprio
 * admin (currentClerkUserId) — a regra tambem vive no server (setUserRole), aqui
 * e so a affordance. Em mock-first currentClerkUserId e null (nada bloqueado).
 */
export function AdminUsersView({
  users: initialUsers,
  currentClerkUserId,
}: {
  users: AdminUser[];
  currentClerkUserId: string | null;
}) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Mantem o estado em sincronia se o server revalidar a pagina.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync com a prop revalidada pelo server (intencional)
  useEffect(() => setUsers(initialUsers), [initialUsers]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(
    () => ({
      total: users.length,
      admins: users.filter((u) => u.role === "admin").length,
    }),
    [users],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(q) || (u.name?.toLowerCase().includes(q) ?? false),
    );
  }, [users, query]);

  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const handleSetRole = (user: AdminUser, role: Role) => {
    if (role === user.role) return;
    startTransition(async () => {
      const result = await setUserRoleAction(user.clerkUserId, role);
      if (result.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.clerkUserId === result.user.clerkUserId ? result.user : u)),
        );
        setToast(role === "admin" ? "Usuário promovido a admin." : "Usuário rebaixado a cliente.");
      } else {
        setToast(result.error);
      }
    });
  };

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Usuários</h1>
          <p className={styles.sub}>
            {counts.admins} admins · {counts.total} no total
          </p>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por e-mail ou nome…"
            aria-label="Buscar usuários"
          />
        </div>
        {query !== "" && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              setQuery("");
              setPage(1);
            }}
          >
            <Icon name="trash" size={12} /> Limpar
          </button>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>
                E-mail
              </th>
              <th scope="col" className={styles.left}>
                Nome
              </th>
              <th scope="col" className={styles.left}>
                Criado em
              </th>
              <th scope="col" className={styles.right}>
                Função
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((u) => {
              const isSelf = currentClerkUserId !== null && u.clerkUserId === currentClerkUserId;
              const isAdmin = u.role === "admin";
              return (
                <tr key={u.id} className={isAdmin ? styles.adminRow : undefined}>
                  <td className={`${styles.left} ${styles.email}`}>
                    {u.email}
                    {isSelf && <span className={styles.youTag}>Você</span>}
                  </td>
                  <td className={styles.left}>
                    {u.name ?? <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.left}>{formatDate(u.createdAt)}</td>
                  <td className={styles.right}>
                    <div
                      className={`${styles.seg} ${isSelf ? styles.segLocked : ""}`}
                      role="group"
                      aria-label={`Função de ${u.email}`}
                      title={isSelf ? "Você não pode alterar a própria função." : undefined}
                    >
                      {ROLES.map((r) => (
                        <button
                          key={r.value}
                          type="button"
                          className={
                            u.role === r.value
                              ? `${styles.segOn} ${r.value === "admin" ? styles.segOnAdmin : ""}`
                              : ""
                          }
                          onClick={() => handleSetRole(u, r.value)}
                          disabled={pending || isSelf}
                          aria-pressed={u.role === r.value}
                          aria-label={`Definir ${u.email} como ${r.label}`}
                          title={
                            isSelf
                              ? "Você não pode alterar a própria função."
                              : `Definir como ${r.label}`
                          }
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {paged.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.emptyCell}>
                  Nenhum usuário encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        total={filtered.length}
        perPage={PER_PAGE}
        onChange={setPage}
        label="usuários"
      />

      {toast && (
        <div className={styles.toast} role="status" aria-live="polite" aria-atomic="true">
          {toast}
        </div>
      )}
    </section>
  );
}
