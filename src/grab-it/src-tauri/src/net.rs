//! Shared settings for outbound HTTPS.

use ureq::tls::{RootCerts, TlsConfig};

/// TLS settings for every HTTP agent: certificates are verified against the
/// roots the operating system trusts (Security.framework on macOS, CryptoAPI
/// on Windows, the system CA bundle on Linux) rather than ureq's bundled
/// Mozilla roots, so an organisation root CA installed by IT, such as a
/// TLS-inspecting proxy's, is trusted as it is by the browser.
pub fn tls_config() -> TlsConfig {
    TlsConfig::builder()
        .root_certs(RootCerts::PlatformVerifier)
        .build()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use ureq::tls::RootCerts;

    #[test]
    fn agents_verify_with_the_platform_trust_store() {
        let stall = Duration::from_secs(1);
        for agent in [
            crate::ffmpeg::download_agent(stall),
            crate::ai::agent(stall),
        ] {
            assert!(matches!(
                agent.config().tls_config().root_certs(),
                RootCerts::PlatformVerifier
            ));
        }
    }
}
