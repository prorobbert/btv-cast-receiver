# Serves the receiver as a static site on port 8080. TLS is terminated in front of it, never here.
FROM nginx:alpine

COPY hosting/nginx.conf /etc/nginx/nginx.conf
COPY index.html receiver.js styles.css version.js /usr/share/nginx/receiver/
COPY assets/ /usr/share/nginx/receiver/assets/

EXPOSE 8080
USER nginx
CMD ["nginx", "-g", "daemon off;"]
