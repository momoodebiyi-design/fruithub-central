import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [{ title: "Privacy Policy — 4ruit Naturel" }],
  }),
  component: PrivacyPage,
});

const retention = [
  [
    "Staff accounts and contact details",
    "While active, then 12 months after access ends. Access is disabled when someone leaves.",
  ],
  [
    "Inventory, production, dispatch, returns and stocktake records",
    "3 years after the transaction.",
  ],
  [
    "Purchase orders, invoices, receipts and payment evidence",
    "6 years after the relevant financial year ends, subject to confirmation of applicable accounting and legal requirements.",
  ],
  ["Operational and financial audit trails", "As long as the related record is retained."],
  ["Login and security logs", "12 months."],
  ["WhatsApp message content and AI conversations held by our app", "90 days."],
  ["Briefing summaries and delivery logs", "12 months."],
  [
    "WhatsApp consent and opt-out records",
    "While enrolled, then 3 years after withdrawal. Minimal information may be retained as necessary to honour an opt-out.",
  ],
  [
    "Recovery backups",
    "A target rolling period of 90 days, subject to the hosting provider’s actual capabilities.",
  ],
];

function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <article className="mx-auto max-w-3xl space-y-8 leading-relaxed">
        <header>
          <p className="text-sm text-muted-foreground">4ruit Naturel</p>
          <h1 className="mt-2 text-3xl font-semibold">Operations App Privacy Policy</h1>
          <p className="mt-3 text-sm text-muted-foreground">Last updated: 10 October 2026</p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Who we are and what this policy covers</h2>
          <p>
            4ruit Naturel is responsible for the personal information used in its internal
            operations application and connected management-briefing services. Our address is No. 5,
            Ilogbo Close, Ojodu Estate, Berger. Contact us at{" "}
            <a className="underline" href="mailto:4ruitnaturel@gmail.com">
              4ruitnaturel@gmail.com
            </a>{" "}
            for privacy questions or requests.
          </p>
          <p>
            This policy covers staff and authorised users, business contacts recorded in operational
            transactions, and people enrolled in our WhatsApp briefing service. It does not describe
            every activity of our retail business.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Information we process</h2>
          <p>
            We process account information such as name, email, role, assigned shop and contact
            number; operational records such as purchases, production, stocktakes, dispatches and
            returns; supplier and customer contact details where provided; uploaded business
            evidence; and audit and security records.
          </p>
          <p>
            For WhatsApp briefings, we process the enrolled phone number, consent and opt-out
            records, incoming requests, message content needed to respond, and delivery status
            information. If an AI assistant is enabled, it may process your question and relevant
            operational summaries. Please do not submit passwords, payment-card details or
            unnecessary sensitive personal information in messages.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Why we use information</h2>
          <p>
            We use information to manage access, document business operations, reconcile stock,
            fulfil authorised transactions, provide management reports and requested briefings,
            investigate errors, protect the system, and meet applicable legal obligations.
          </p>
          <p>
            Depending on the activity, our lawful basis may be consent, performance of a contract, a
            legal obligation, or a legitimate interest where permitted and balanced against your
            rights. Optional WhatsApp enrolment is based on consent; operational recordkeeping may
            rely on another applicable lawful basis.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">WhatsApp choices</h2>
          <p>
            Enrolled recipients may receive management briefings and request updates by message.
            WhatsApp is not required to use the main application. You can withdraw from the briefing
            service in the app, send STOP to our connected WhatsApp sender, or contact us.
            Withdrawal stops future optional briefings, but does not automatically erase business
            records retained on another lawful basis.
          </p>
          <p>
            App links in messages still require appropriate sign-in and permissions. Copies of
            messages on recipients’ devices and information independently retained by Meta are
            governed by their own settings and policies.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">
            Access, service providers and international processing
          </h2>
          <p>
            Access within 4ruit Naturel is limited according to assigned roles and operational
            needs. Providers supporting the application include Lovable and Supabase for application
            and data services, and Meta for connected WhatsApp messaging. Where enabled, an
            OpenAI-powered assistant may receive questions and relevant summaries to generate
            read-only responses. We may also disclose information where legally required or
            necessary to protect lawful rights.
          </p>
          <p>
            Providers may process information outside Nigeria. Where an international transfer
            occurs, we must assess applicable requirements and use appropriate safeguards.
            Providers’ own retention practices and policies may differ from the periods for records
            held by our application.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Retention</h2>
          <p>
            We have adopted the following retention schedule. It is a policy schedule, not a claim
            that automated deletion is already implemented for every record type. Hosting and backup
            capabilities and applicable financial-record requirements must be verified;
            implementation and compliance are reviewed accordingly.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr>
                  <th scope="col" className="border-b p-3">
                    Record
                  </th>
                  <th scope="col" className="border-b p-3">
                    Retention period
                  </th>
                </tr>
              </thead>
              <tbody>
                {retention.map(([record, period]) => (
                  <tr key={record}>
                    <th scope="row" className="border-b p-3 align-top font-medium">
                      {record}
                    </th>
                    <td className="border-b p-3 align-top">{period}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            When information is no longer needed, it should be deleted or irreversibly anonymised.
            An unresolved dispute, investigation or legal obligation may justify a longer,
            documented hold. Non-identifying business statistics may be retained for analysis.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Security</h2>
          <p>
            We use access controls, authentication, server-side credential handling and audit
            records to help protect information. No system or messaging service can guarantee
            absolute security. Report suspected unauthorised access promptly to our privacy contact.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Your rights and requests</h2>
          <p>
            Subject to applicable law, you may request access, correction, deletion or restriction
            of your personal information, object to certain processing, request portability where
            applicable, or withdraw consent. Send requests to{" "}
            <a className="underline" href="mailto:4ruitnaturel@gmail.com">
              4ruitnaturel@gmail.com
            </a>
            . We may verify your identity before responding. Some records may need to remain for a
            lawful obligation or another valid basis; we will explain relevant limitations.
          </p>
          <p>
            You may also raise a complaint with the{" "}
            <a className="underline" href="https://ndpc.gov.ng/">
              Nigeria Data Protection Commission
            </a>
            .
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Updates</h2>
          <p>
            We may update this policy as our services or obligations change. The date above
            identifies the latest version. Material changes will be communicated through an
            appropriate channel.
          </p>
        </section>
        <footer className="border-t pt-6 text-sm">
          <a className="underline" href="/auth">
            Return to sign in
          </a>
        </footer>
      </article>
    </main>
  );
}
