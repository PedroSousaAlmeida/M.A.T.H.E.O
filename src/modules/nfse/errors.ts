export class InvalidCertificateError extends Error {
  constructor(message = 'Invalid certificate file or password') {
    super(message);
    this.name = 'InvalidCertificateError';
  }
}

/** The national API accepted the request but rejected it by a business rule. */
export class NfseRejectedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NfseRejectedError';
  }
}

/** Network error, timeout or 5xx from the national API. */
export class NfseUnavailableError extends Error {
  constructor(message = 'National NFS-e API unavailable') {
    super(message);
    this.name = 'NfseUnavailableError';
  }
}
