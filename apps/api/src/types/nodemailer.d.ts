// nodemailer 10 ships no type declarations; this covers the part Supply360 uses.
declare module 'nodemailer' {
  interface TransportOptions {
    host: string;
    port: number;
    secure: boolean;
    requireTLS?: boolean;
    auth?: { user: string; pass: string };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
  }
  interface Transporter {
    sendMail(m: { from: string; to: string[]; subject: string; text: string; html: string }): Promise<unknown>;
    close(): void;
  }
  const nodemailer: { createTransport(o: TransportOptions): Transporter };
  export default nodemailer;
}
