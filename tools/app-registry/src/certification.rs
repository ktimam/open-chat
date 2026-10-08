use ic_http_certification::{
    utils::add_v2_certificate_header, DefaultCelBuilder, DefaultResponseCertification,
    HttpCertification, HttpCertificationPath, HttpCertificationTree, HttpCertificationTreeEntry,
    HttpRequest, HttpResponse, StatusCode, CERTIFICATE_EXPRESSION_HEADER_NAME,
};
use std::collections::BTreeMap;

struct CertifiedResponse {
    response: HttpResponse<'static>,
    certification: HttpCertification,
}

pub struct CertifiedDirectory {
    tree: HttpCertificationTree,
    pages: BTreeMap<String, CertifiedResponse>,
    missing: CertifiedResponse,
}

fn headers() -> Vec<(String, String)> {
    vec![
        (
            "content-type".into(),
            "application/json; charset=utf-8".into(),
        ),
        ("access-control-allow-origin".into(), "*".into()),
        ("cache-control".into(), "no-store".into()),
        ("x-content-type-options".into(), "nosniff".into()),
    ]
}
fn response(status: StatusCode, body: Vec<u8>) -> HttpResponse<'static> {
    HttpResponse::builder()
        .with_status_code(status)
        .with_headers(headers())
        .with_body(body)
        .build()
}

impl CertifiedDirectory {
    pub fn new(pages: BTreeMap<String, Vec<u8>>) -> Result<Self, String> {
        let expression = DefaultCelBuilder::full_certification()
            .with_request_headers(vec![])
            .with_request_query_parameters(vec![])
            .with_response_certification(DefaultResponseCertification::response_header_exclusions(
                vec![],
            ))
            .build();
        let missing_expression = DefaultCelBuilder::response_only_certification()
            .with_response_certification(DefaultResponseCertification::response_header_exclusions(
                vec![],
            ))
            .build();
        let mut tree = HttpCertificationTree::default();
        let mut responses = BTreeMap::new();
        for (path, bytes) in pages {
            let request = HttpRequest::get(path.clone()).build();
            let mut response = response(StatusCode::OK, bytes);
            response.add_header((
                CERTIFICATE_EXPRESSION_HEADER_NAME.into(),
                expression.to_string(),
            ));
            let certification = HttpCertification::full(&expression, &request, &response, None)
                .map_err(|e| e.to_string())?;
            tree.insert(&HttpCertificationTreeEntry::new(
                HttpCertificationPath::exact(path.clone()),
                certification.clone(),
            ));
            responses.insert(
                path,
                CertifiedResponse {
                    response,
                    certification,
                },
            );
        }
        let mut missing = response(StatusCode::NOT_FOUND, br#"{"error":"Not found"}"#.to_vec());
        missing.add_header((
            CERTIFICATE_EXPRESSION_HEADER_NAME.into(),
            missing_expression.to_string(),
        ));
        let certification = HttpCertification::response_only(&missing_expression, &missing, None)
            .map_err(|e| e.to_string())?;
        tree.insert(&HttpCertificationTreeEntry::new(
            HttpCertificationPath::wildcard(""),
            certification.clone(),
        ));
        Ok(Self {
            tree,
            pages: responses,
            missing: CertifiedResponse {
                response: missing,
                certification,
            },
        })
    }
    pub fn root_hash(&self) -> [u8; 32] {
        self.tree.root_hash()
    }
    pub fn serve(
        &self,
        request: &HttpRequest<'_>,
        certificate: &[u8],
    ) -> Result<HttpResponse<'static>, String> {
        // No URL normalisation, queries, request bodies, HTTP updates, or arbitrary proxying.
        // Only exact GET paths receive directory content. Invalid request forms fail closed.
        if request.method().as_str() != "GET" {
            return Ok(response(
                StatusCode::METHOD_NOT_ALLOWED,
                br#"{"error":"GET only"}"#.to_vec(),
            ));
        }
        let path = request.url();
        if !path.starts_with('/')
            || path.contains('?')
            || path.contains('#')
            || !request.body().is_empty()
            || path.len() > 2048
        {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                br#"{"error":"Exact path required"}"#.to_vec(),
            ));
        }
        let (tree_path, stored) = match self.pages.get(path) {
            Some(page) => (HttpCertificationPath::exact(path), page),
            None => (HttpCertificationPath::wildcard(""), &self.missing),
        };
        let mut response = stored.response.clone();
        let witness = self
            .tree
            .witness(
                &HttpCertificationTreeEntry::new(&tree_path, &stored.certification),
                path,
            )
            .map_err(|e| e.to_string())?;
        add_v2_certificate_header(
            certificate,
            &mut response,
            &witness,
            &tree_path.to_expr_path(),
        );
        Ok(response)
    }
}
