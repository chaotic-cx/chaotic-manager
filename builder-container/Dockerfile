FROM archlinux:latest

# Set up a basic Arch container with Chaotic-AUR enabled
RUN curl -o /etc/pacman.d/mirrorlist "https://archlinux.org/mirrorlist/?country=DE&protocol=https&use_mirror_status=on" && \
    sed -i 's/^#//' /etc/pacman.d/mirrorlist && echo "RemoteFileSigLevel = Never" >> /etc/pacman.conf && echo -e "[multilib]\nInclude = /etc/pacman.d/mirrorlist" >> /etc/pacman.conf && \
    pacman -Syu --noconfirm base-devel namcap sudo git && \
    pacman -Scc --noconfirm

RUN useradd -m builder && usermod -aG wheel builder
# Disable sudo password for builder
RUN printf '%s\n%s' '%wheel ALL=(ALL) NOPASSWD:ALL' 'Defaults runcwd=*' >> /etc/sudoers

COPY ./entry_point.sh /entry_point.sh
COPY ./build.sh /build.sh
COPY ./interfere.sh /interfere.sh
COPY ./add-database.sh /add-database.sh
COPY ./auto-database-remove.sh /auto-database-remove.sh
COPY ./parse-database.awk /parse-database.awk
RUN chmod +x /entry_point.sh /build.sh /add-database.sh /interfere.sh /auto-database-remove.sh

ENTRYPOINT ["/entry_point.sh"]